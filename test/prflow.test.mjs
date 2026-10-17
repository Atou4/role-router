import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codex } from '../lib/agents/codex.mjs';
import { loadBoard, setStatus } from '../lib/board.mjs';
import { dispatch } from '../lib/dispatch.mjs';
import { listEscalations } from '../lib/escalations.mjs';
import { runNext } from '../lib/next.mjs';
import { suggestions } from '../lib/nextsteps.mjs';
import { openPr } from '../lib/pr.mjs';
import { autoOpen, pullRequests, feedbackPath, feedbackPrompt, intakeFeedback, readPrState, reviewPr, reviewVerdict, reworkReason } from '../lib/prflow.mjs';
import { syncRepo } from '../lib/sync.mjs';

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' });
function repo(plan, { github = true } = {}) {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'rr-prflow-')), 'App');
  mkdirSync(root);
  writeFileSync(path.join(root, 'PLAN.md'), plan);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  if (github) git(root, 'remote', 'add', 'origin', 'git@github.com:o/app.git');
  return root;
}
const PASSED = '## TASK-002 — orders\n- status: passed\n- depends:\n';
const T0 = '2026-10-01T10:00:00Z';
const T1 = '2026-10-02T10:00:00Z';

// A fake gh: answers from a table, everything else goes to the real git.
function fakeGh(answers) {
  const calls = [];
  const run = (cmd, args, cwd) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'gh') {
      const key = Object.keys(answers).find((k) => [cmd, ...args].join(' ').startsWith(k));
      const v = key ? answers[key] : undefined;
      return v === undefined ? { status: 1, stdout: '', stderr: 'no fake' } : { status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' };
    }
    return spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  };
  run.calls = calls;
  return run;
}
const openPrList = (over = {}) => [{ headRefName: 'task/TASK-002', headRefOid: 'sha1', state: 'OPEN', url: 'https://github.com/o/app/pull/7', number: 7, reviewDecision: '', latestReviews: [], statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/app/actions/runs/99/job/1' }], ...over }];

test('rework triggers once per piece of feedback: CI by head commit, reviews and /rework by time', () => {
  const pr = { checks: 'failing', headSha: 's1', reviews: [] };
  assert.equal(reworkReason(pr, {}), 'CI failing');
  assert.equal(reworkReason(pr, { handledSha: 's1' }), null, 'the same failing commit is not reworked twice');
  const reviewed = { checks: 'green', headSha: 's2', reviews: [{ state: 'CHANGES_REQUESTED', at: T1 }] };
  assert.equal(reworkReason(reviewed, { handledAt: T0 }), 'changes requested');
  assert.equal(reworkReason(reviewed, { handledAt: '2026-10-03T00:00:00Z' }), null, 'an old review is not a new request');
  assert.equal(reworkReason({ checks: 'green', reviews: [] }, { handledAt: T0 }, [{ body: 'looks off\n/rework please split it', at: T1 }]), '/rework comment');
  assert.equal(reworkReason({ checks: 'pending', reviews: [] }, {}, [{ body: 'nice', at: T1 }]), null);
});

test('sync sends a passed task back for rework with the PR feedback, once, and parks it after the last round', () => {
  const root = repo(PASSED);
  const run = fakeGh({
    'gh pr list': openPrList(),
    'gh pr view 7': { reviews: [], comments: [{ author: { login: 'sam' }, body: 'Also the empty cart case', createdAt: T1 }], statusCheckRollup: openPrList()[0].statusCheckRollup },
    'gh api repos/{owner}/{repo}/pulls/7/comments': [{ path: 'src/orders.ts', line: 12, user: { login: 'sam' }, body: 'off by one', created_at: T1 }],
    'gh run view 99 --log-failed': 'test\tFAIL src/orders.test.ts\nexpected 3, got 2',
  });
  const feedback = (r) => intakeFeedback(r, { run });
  const first = syncRepo(root, { gh: () => null, feedback });
  assert.deepEqual(first.rework, ['TASK-002 (CI failing)']);
  assert.equal(loadBoard(root).byId.get('TASK-002').status, 'gaps_found');
  const md = readFileSync(feedbackPath(root, 'TASK-002'), 'utf8');
  for (const want of [/PR #7/, /expected 3, got 2/, /src\/orders\.ts:12.*off by one/, /empty cart case/]) assert.match(md, want);
  assert.match(feedbackPrompt(root, 'TASK-002'), /Feedback on the open PR \(binding\)/);

  // The fix passed again but nothing new was pushed: the same failure is not acted on twice.
  setStatus(root, 'TASK-002', 'passed');
  assert.deepEqual(syncRepo(root, { gh: () => null, feedback }).rework, []);

  // New pushes keep failing: rounds are bounded (fixRounds 2), then it goes to the inbox.
  for (const [sha, expect] of [['sha2', 'rework'], ['sha3', 'parked']]) {
    setStatus(root, 'TASK-002', 'passed');
    const again = fakeGh({ 'gh pr list': openPrList({ headRefOid: sha }), 'gh pr view 7': { reviews: [], comments: [], statusCheckRollup: [] } });
    const r = syncRepo(root, { gh: () => null, feedback: (x) => intakeFeedback(x, { run: again }) });
    assert.equal(r[expect].length, 1, `${sha}: ${JSON.stringify(r)}`);
  }
  assert.equal(readPrState(root, 'TASK-002').rounds, 3);
  assert.equal(loadBoard(root).byId.get('TASK-002').status, 'human_needed');
  assert.match(listEscalations([root])[0].question, /still has feedback \(CI failing\) after 2 fix round/);
});

test('the Builder gets the PR feedback in its prompt', async () => {
  const root = repo('## TASK-002 — orders\n- status: gaps_found\n- depends:\n', { github: false });
  mkdirSync(path.dirname(feedbackPath(root, 'TASK-002')), { recursive: true });
  writeFileSync(feedbackPath(root, 'TASK-002'), 'Reason: CI failing\n');
  let seen = '';
  const fake = { ...codex, preflight: () => null, launch: (p, a, prompt) => { seen = prompt; return { command: process.execPath, args: ['-e', 'console.log(JSON.stringify({type:"turn.completed",usage:{}}))'] }; } };
  const config = { version: 2, accounts: { A: { agent: 'codex' } }, profiles: { a: { id: 'a', account: 'A', tier: 'lite' } }, roles: { builder: { chain: ['a'], onTierDrop: 'auto' } }, defaults: { cooldownMinutes: 60, transientRetries: 0, runTimeoutMinutes: 30 } };
  await dispatch({ role: 'builder', task: 'TASK-002', mode: 'headless', cwd: root }, { agents: { codex: fake, claude: fake, opencode: fake }, config, skills: () => ({ stacks: [], skills: [], references: [], missing: [], dropped: [] }) });
  assert.match(seen, /Feedback on the open PR \(binding\)[\s\S]*pr-feedback\.md/);
});

test('a passed task opens its PR automatically on GitHub only, and the loop reports the link', async () => {
  const local = repo(PASSED, { github: false });
  assert.deepEqual(autoOpen(local, 'TASK-002'), { skipped: 'not a GitHub repo' });
  const gh = repo(PASSED);
  assert.deepEqual(autoOpen(gh, 'TASK-002', { settings: { auto: false } }), { skipped: 'pr.auto is off' });
  mkdirSync(path.dirname(feedbackPath(gh, 'TASK-002')), { recursive: true });
  writeFileSync(feedbackPath(gh, 'TASK-002'), 'old');
  const opened = autoOpen(gh, 'TASK-002', { settings: { auto: true, draft: false }, open: () => ({ url: 'https://github.com/o/app/pull/7' }) });
  assert.deepEqual(opened, { url: 'https://github.com/o/app/pull/7' });
  assert.equal(existsSync(feedbackPath(gh, 'TASK-002')), false, 'addressed feedback is archived');
  assert.match(autoOpen(gh, 'TASK-002', { settings: { auto: true }, open: () => { throw new Error('gh: not logged in'); } }).error, /not logged in/);

  const root = repo('## TASK-001 — a\n- status: planned\n- depends:\n', { github: false });
  const steps = { builder: 'review', review: 'passed' };
  const fakeDispatch = async ({ role, task }) => { if (steps[role]) setStatus(root, task, steps[role]); return { status: 'ok', runs: [{ profile: 'p' }] }; };
  const r = await runNext({ root, dispatch: fakeDispatch, policy: { notify: false }, autoOpen: () => ({ url: 'https://github.com/o/app/pull/9' }) });
  assert.equal(r.stop, 'passed');
  assert.match(r.message, /PR opened: https:\/\/github\.com\/o\/app\/pull\/9/);
});

test('an existing PR gets the new commits and a refreshed description', () => {
  const root = repo(PASSED);
  git(root, 'branch', 'task/TASK-002');
  mkdirSync(path.join(root, '.role-router', 'runs', 'TASK-002'), { recursive: true });
  writeFileSync(path.join(root, '.role-router', 'runs', 'TASK-002', '0001-docs.json'), JSON.stringify({ operation: 'docs', result: { kind: 'ok', summary: '## PR body\nFixed.' } }));
  const calls = [];
  const r = openPr(root, { id: 'TASK-002', title: 'orders' }, { sh: (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return { status: 0, stdout: cmd === 'gh' && args[1] === 'list' ? JSON.stringify([{ headRefName: 'task/TASK-002-extra', url: 'wrong' }, { headRefName: 'task/TASK-002', url: 'https://github.com/o/app/pull/7' }]) : '' };
  } });
  assert.equal(r.url, 'https://github.com/o/app/pull/7');
  assert.ok(calls.some((c) => c.startsWith('gh pr edit https://github.com/o/app/pull/7 --body-file')));
  assert.equal(calls.some((c) => c.startsWith('gh pr create')), false);
});

test('PR listing finds an open task PR without gh search and fails closed on query error', () => {
  const root = repo(PASSED);
  const run = fakeGh({ 'gh pr list': [{ headRefName: 'feature/x', state: 'OPEN' }, ...openPrList()] });
  const prs = pullRequests(root, { run, ttlMs: 0 });
  assert.equal(prs.get('TASK-002').number, 7);
  assert.equal(prs.size, 1);
  assert.ok(run.calls.some((c) => c.includes('gh pr list --state all --limit 1000')));
  assert.equal(run.calls.some((c) => c.includes('--search')), false);
  const failed = pullRequests(root, { run: fakeGh({}), ttlMs: 0 });
  assert.equal(failed, null);
  assert.equal(suggestions([{ root, name: 'App' }], { prs: () => null }).steps.some((step) => step.kind === 'pr'), false);
});

test('pr-review: the most severe verdict wins, the comment is marked, blockers send the task back', async () => {
  assert.equal(reviewVerdict('## Findings\nnone\n\nverdict: approve'), 'approve');
  assert.equal(reviewVerdict('**Verdict:** request changes'), 'request_changes');
  const root = repo(PASSED, { github: false });
  git(root, 'checkout', '-qb', 'task/TASK-002');
  writeFileSync(path.join(root, 'orders.js'), 'export const total = (xs) => xs.length - 1;\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'orders');
  git(root, 'checkout', '-q', 'main');
  const config = { profiles: { 'openai-top': { account: 'openai', tier: 'top' }, 'anthropic-top': { account: 'anthropic', tier: 'top' } } };
  let prompt;
  const fan = async ({ prompt: p, profiles, out }) => {
    prompt = p;
    const lanes = profiles.map((profile, i) => {
      const answer = path.join(out, `${profile}.md`);
      writeFileSync(answer, i === 0 ? '## Findings\n- [blocker] orders.js:1: total is off by one\n\nverdict: request_changes' : '## Findings\nnone\n\nverdict: approve');
      return { profile, status: 'ok', answer };
    });
    return { out, lanes };
  };
  const emptyLane = async (o) => { const r = await fan(o); writeFileSync(r.lanes[1].answer, '\n'); return r; };
  const partial = await reviewPr(root, { id: 'TASK-002', panel: true, fan: emptyLane, config, rework: false });
  assert.match(partial.comment, /Reviewed by openai-top\. \(no answer: anthropic-top crashed \(empty answer\)\)/);
  const r = await reviewPr(root, { id: 'TASK-002', panel: true, fan, config });
  assert.match(prompt, /diff\.patch/);
  assert.match(readFileSync(path.join(path.dirname(r.commentFile), 'diff.patch'), 'utf8'), /xs\.length - 1/);
  assert.equal(r.verdict, 'request_changes');
  assert.match(r.comment, /^<!-- role-router:pr-review -->/);
  assert.match(r.comment, /openai-top: request changes · anthropic-top: approve/);
  assert.equal(r.posted, undefined, 'nothing is posted without GitHub');
  assert.equal(r.rework, 'rework');
  assert.equal(loadBoard(root).byId.get('TASK-002').status, 'gaps_found');
  assert.match(readFileSync(feedbackPath(root, 'TASK-002'), 'utf8'), /off by one/);
});

test('the NEXT panel turns PR feedback into a rework step', () => {
  const root = repo(PASSED);
  const prs = () => new Map([['TASK-002', { state: 'OPEN', number: 7, url: 'u', headSha: 's1', checks: 'failing', reviews: [] }]]);
  const { steps } = suggestions([{ root, name: 'App' }], { prs });
  assert.equal(steps[0].kind, 'rework');
  assert.deepEqual(steps[0].argv, ['launch', 'App:TASK-002', '--detach', '--yes']);
});

test('OpenCode may use the main .role-router from a worktree, and an empty run is not an answer', async () => {
  const { allowDirs, opencode } = await import('../lib/agents/opencode.mjs');
  const merged = JSON.parse(allowDirs(['/r/.role-router'], JSON.stringify({ permission: { bash: 'ask', external_directory: 'deny' }, model: 'x' })));
  assert.deepEqual(merged, { model: 'x', permission: { bash: 'ask', external_directory: { '*': 'deny', '/r/.role-router/**': 'allow' } } });
  const l = opencode.launch({ model: 'opencode/m' }, {}, 'hi', { mode: 'headless', cwd: '/r/.role-router/worktrees/T', repoRoot: '/r', addDirs: ['/extra'] });
  assert.deepEqual(Object.keys(JSON.parse(l.env.OPENCODE_CONFIG_CONTENT).permission.external_directory), ['/r/.role-router/**', '/extra/**']);
  const c = opencode.classifier();
  c.onLine(JSON.stringify({ type: 'step_start', sessionID: 's' }));
  assert.equal(c.finish(0).kind, 'crashed');
});

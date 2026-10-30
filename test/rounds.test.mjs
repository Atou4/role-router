import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setStatus } from '../lib/board.mjs';
import { integrateBase, integrationPrompt } from '../lib/integrate.mjs';
import { runNext } from '../lib/next.mjs';
import { reworkReason } from '../lib/prflow.mjs';
import { disputed, findingTags, findingsPrompt, openReview, previousRoundPrompt, responsePath, unverifiedNotes, verdictOf } from '../lib/rounds.mjs';
import { ensureWorktree } from '../lib/worktree.mjs';

const PLAN = '## TASK-001 — A\n- status: planned\n- depends:\n';
const plain = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-rounds-'));
  writeFileSync(path.join(root, 'PLAN.md'), PLAN);
  return root;
};
const quiet = { notify: false };
const noMerge = () => ({ status: 'skipped' });

// A dispatch that writes run records like the real one: the Builder answers the open review with
// `answers[i]` (i = the review it answers), each review says `reviews[i]` and sets the verdict it ends with.
function agents(root, reviews, answers = []) {
  const calls = [];
  let n = 0; let r = 0;
  const dispatch = async ({ role, task }) => {
    calls.push(role);
    let summary = `${role} done`;
    if (role === 'builder') {
      const open = openReview(root, task);
      if (open && answers[r - 1]) writeFileSync(responsePath(root, task, open.run), answers[r - 1]);
      setStatus(root, task, 'review');
    }
    if (role === 'review') { summary = reviews[r++]; setStatus(root, task, verdictOf(summary)); }
    const dir = path.join(root, '.role-router', 'runs', task);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${String(++n).padStart(3, '0')}-p-${role}.json`), JSON.stringify({ operation: role, result: { kind: 'ok', summary } }));
    return { status: 'ok', runs: [{ profile: 'p', result: { summary } }] };
  };
  return { dispatch, calls };
}

test('finding tags, kept findings and disputes are read from the text', () => {
  assert.deepEqual(findingTags('- [MF1] a\n- **[MF2]** b\n- [MF3 kept] c'), { fresh: [1, 2], kept: [3] });
  assert.deepEqual(findingTags('no tags here'), { fresh: [], kept: [] });
  const d = disputed('- [MF1] fixed in abc: x\n- [MF2] disputed: already at a.js:3\n- [MF3] **disputed**: test t proves it');
  assert.deepEqual([...d.keys()], [2, 3]);
  assert.equal(d.get(2), '[MF2] disputed: already at a.js:3');
});

test('rounds that bring new findings get a repair pass, up to the total cap', async () => {
  const root = plain();
  const { dispatch, calls } = agents(root, ['- [MF1] a\ngaps_found', '- [MF2] b\ngaps_found', '- [MF3] c\ngaps_found', 'passed']);
  const r = await runNext({ root, dispatch, integrate: noMerge, autoOpen: () => ({}), policy: { ...quiet, maxReviewRounds: 2, maxReviewRoundsTotal: 4 } });
  assert.equal(r.stop, 'passed', r.message);
  assert.deepEqual(calls, ['builder', 'review', 'builder', 'review', 'builder', 'review', 'builder', 'review', 'docs']);
});

test('the total cap still bounds rounds of new findings', async () => {
  const root = plain();
  const { dispatch, calls } = agents(root, ['[MF1]\ngaps_found', '[MF2]\ngaps_found', '[MF3]\ngaps_found']);
  const r = await runNext({ root, dispatch, integrate: noMerge, policy: { ...quiet, maxReviewRounds: 2, maxReviewRoundsTotal: 3 } });
  assert.equal(r.stop, 'gaps_found');
  assert.match(r.message, /3 review rounds, the most allowed/);
  assert.equal(calls.filter((c) => c === 'review').length, 3);
});

test('a finding kept after the fix counts; two such rounds stop for a human', async () => {
  const root = plain();
  const { dispatch, calls } = agents(root, ['[MF1] a\ngaps_found', '[MF1 kept] still\ngaps_found', '[MF1 kept] still\ngaps_found'], ['[MF1] fixed in abc', '[MF1] fixed in def']);
  const r = await runNext({ root, dispatch, integrate: noMerge, policy: { ...quiet, maxReviewRounds: 2 } });
  assert.equal(r.stop, 'gaps_found');
  assert.match(r.message, /2 review round\(s\) that kept a finding/);
  assert.deepEqual(calls, ['builder', 'review', 'builder', 'review', 'builder', 'review']);
});

test('untagged findings cannot be told apart, so they count as before', async () => {
  const root = plain();
  const { dispatch, calls } = agents(root, ['a bug\ngaps_found', 'a bug\ngaps_found']);
  const r = await runNext({ root, dispatch, integrate: noMerge, policy: { ...quiet, maxReviewRounds: 2 } });
  assert.equal(r.stop, 'gaps_found');
  assert.deepEqual(calls, ['builder', 'review', 'builder', 'review']);
});

test('a disputed finding the reviewer keeps goes to a human with both sides', async () => {
  const root = plain();
  const { dispatch, calls } = agents(root, ['- [MF1] cancel does not supersede\ngaps_found', '- [MF1 kept] the call is after the update\ngaps_found'], ['- [MF1] disputed: supersede is the first call, orders.service.ts:1227']);
  const r = await runNext({ root, dispatch, integrate: noMerge, policy: { ...quiet, maxReviewRounds: 2 } });
  assert.equal(r.stop, 'disputed');
  assert.match(r.message, /kept MF1 after the Builder disputed it/);
  assert.deepEqual(calls, ['builder', 'review', 'builder', 'review']);
  const inbox = readFileSync(path.join(root, '.role-router', 'escalations', 'TASK-001.md'), 'utf8');
  assert.match(inbox, /orders\.service\.ts:1227/);
  assert.match(inbox, /the call is after the update/);
});

test('the Builder gets the findings and the reviewer gets the Builder\'s answers', async () => {
  const root = plain();
  const { dispatch } = agents(root, ['- [MF1] a.js:3 wrong\ngaps_found']);
  await runNext({ root, dispatch, integrate: noMerge, policy: { ...quiet, maxReviewRounds: 1, maxReviewRoundsTotal: 1 } });
  const open = openReview(root, 'TASK-001');
  assert.equal(open.rebuilt, false);
  assert.match(findingsPrompt(root, 'TASK-001'), /\[MF1\] a\.js:3 wrong[\s\S]*review-response-002-p-review\.md/);
  assert.equal(previousRoundPrompt(root, 'TASK-001'), '', 'no rebuild yet: nothing to re-check');
  writeFileSync(responsePath(root, 'TASK-001', open.run), '- [MF1] disputed: it is right\n');
  writeFileSync(path.join(root, '.role-router', 'runs', 'TASK-001', '003-p-builder.json'), JSON.stringify({ operation: 'builder', result: { kind: 'ok', summary: 'x' } }));
  const prompt = previousRoundPrompt(root, 'TASK-001');
  assert.match(prompt, /\[MF1\] a\.js:3 wrong/);
  assert.match(prompt, /disputed: it is right/);
  assert.match(prompt, /\[MFn kept\]/);
  writeFileSync(path.join(root, '.role-router', 'runs', 'TASK-001', '004-p-review.json'), JSON.stringify({ operation: 'review', result: { kind: 'ok', summary: 'Unverified by reviewer: AC2 — Postgres would not start (hdiutil)\n\npassed' } }));
  assert.equal(findingsPrompt(root, 'TASK-001'), '', 'a passing review closes the round');
  assert.deepEqual(unverifiedNotes(root, 'TASK-001'), ['Unverified by reviewer: AC2 — Postgres would not start (hdiutil)']);
});

// ── integration with the base ──────────────────────────────────────────────────────────────────

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
function gitRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-integrate-'));
  writeFileSync(path.join(root, 'PLAN.md'), PLAN);
  writeFileSync(path.join(root, 'a.js'), 'one\n');
  writeFileSync(path.join(root, 'b.js'), 'one\n');
  writeFileSync(path.join(root, '.gitignore'), '.role-router/\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  const wt = ensureWorktree(root, 'TASK-001', 'HEAD', { setup: false });
  writeFileSync(path.join(wt, 'a.js'), 'task\n'); git(wt, 'commit', '-qam', 'task work');
  return { root, wt };
}
const commitOn = (cwd, file, text, msg) => { writeFileSync(path.join(cwd, file), text); git(cwd, 'commit', '-qam', msg); };

test('the base is merged into the task branch; up to date is a no-op', () => {
  const { root, wt } = gitRepo();
  assert.equal(integrateBase(wt, 'TASK-001').status, 'current');
  commitOn(root, 'b.js', 'main moved\n', 'other task merged');
  const r = integrateBase(wt, 'TASK-001');
  assert.equal(r.status, 'merged');
  assert.equal(r.target, 'main');
  assert.equal(r.behind, 1);
  assert.equal(readFileSync(path.join(wt, 'b.js'), 'utf8'), 'main moved\n');
  assert.equal(readFileSync(path.join(wt, 'a.js'), 'utf8'), 'task\n');
  assert.match(integrationPrompt(wt, 'TASK-001', 'review'), /merged 1 commit\(s\) from main[\s\S]*git diff main\.\.\.HEAD/);
  assert.equal(integrationPrompt(wt, 'TASK-001', 'builder'), '');
});

test('a conflicting merge is cancelled and handed to the Builder', () => {
  const { root, wt } = gitRepo();
  commitOn(root, 'a.js', 'main changed it too\n', 'conflicting change');
  const r = integrateBase(wt, 'TASK-001');
  assert.equal(r.status, 'conflicts');
  assert.deepEqual(r.files, ['a.js']);
  assert.equal(git(wt, 'status', '--porcelain'), '', 'the merge was aborted: the tree is clean');
  assert.equal(readFileSync(path.join(wt, 'a.js'), 'utf8'), 'task\n');
  assert.match(integrationPrompt(wt, 'TASK-001', 'builder'), /Bring in main first[\s\S]*- a\.js[\s\S]*git merge main/);
  assert.equal(integrationPrompt(wt, 'TASK-001', 'review'), '');
});

test('with a remote, the base comes from origin: unpushed local commits stay out of the PR', () => {
  const { root, wt } = gitRepo();
  const remote = mkdtempSync(path.join(os.tmpdir(), 'rr-remote-'));
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', 'origin', 'main');
  const other = mkdtempSync(path.join(os.tmpdir(), 'rr-clone-'));
  git(other, 'clone', '-q', remote, '.');
  commitOn(other, 'b.js', 'merged on GitHub\n', 'PR merged'); git(other, 'push', '-q', 'origin', 'main');
  writeFileSync(path.join(root, 'local.txt'), 'x\n'); git(root, 'add', 'local.txt'); git(root, 'commit', '-qm', 'local only');
  const r = integrateBase(wt, 'TASK-001');
  assert.equal(r.status, 'merged');
  assert.equal(r.target, 'origin/main');
  assert.equal(readFileSync(path.join(wt, 'b.js'), 'utf8'), 'merged on GitHub\n');
  assert.equal(existsSync(path.join(wt, 'local.txt')), false);
});

test('uncommitted work and other branches are left alone', () => {
  const { root, wt } = gitRepo();
  commitOn(root, 'b.js', 'moved\n', 'moved');
  writeFileSync(path.join(wt, 'a.js'), 'half done\n');
  assert.deepEqual(integrateBase(wt, 'TASK-001'), { status: 'skipped', why: 'uncommitted changes' });
  assert.equal(integrateBase(root, 'TASK-001').status, 'skipped', 'the main checkout is not a task branch');
});

test('the loop sends conflicts to the Builder before reviewing, and gives up after two tries', async () => {
  const root = plain();
  const { dispatch, calls } = agents(root, ['passed']);
  const merges = ['current', 'conflicts', 'current', 'current'];
  const integrate = () => ({ status: merges.shift() ?? 'current', target: 'origin/main', files: ['a.js'] });
  const r = await runNext({ root, dispatch, integrate, autoOpen: () => ({}), policy: quiet });
  assert.equal(r.stop, 'passed', r.message);
  assert.deepEqual(calls, ['builder', 'builder', 'review', 'docs']);
  assert.ok(r.steps.some((s) => s.role === 'integrate' && s.status === 'conflicts'));

  const root2 = plain();
  const a2 = agents(root2, []);
  const always = () => ({ status: 'conflicts', target: 'origin/main', files: ['a.js'] });
  const r2 = await runNext({ root: root2, dispatch: a2.dispatch, integrate: always, policy: quiet });
  assert.equal(r2.stop, 'conflicts');
  assert.match(r2.message, /still conflicts after two Builder passes \(a\.js\)/);
  assert.deepEqual(a2.calls, ['builder', 'builder', 'builder']);
});

test('an open PR GitHub reports as conflicting goes back for rework, once per head', () => {
  const pr = { checks: 'green', headSha: 'abc', reviews: [], mergeable: 'CONFLICTING', base: 'main' };
  assert.equal(reworkReason(pr, {}), 'conflicts with main');
  assert.equal(reworkReason(pr, { handledSha: 'abc' }), null);
  assert.equal(reworkReason({ ...pr, mergeable: 'MERGEABLE' }, {}), null);
});

test('dispatch hands the findings to the Builder and the base and earlier round to the reviewer', async () => {
  const { codex } = await import('../lib/agents/codex.mjs');
  const { dispatch } = await import('../lib/dispatch.mjs');
  const { root, wt } = gitRepo();
  const prompts = [];
  const fake = { ...codex, preflight: () => null, launch: (p, a, prompt) => {
    prompts.push(prompt);
    return { command: process.execPath, args: ['-e', 'console.log(JSON.stringify({type:"turn.completed",usage:{}}))'] };
  } };
  const config = { version: 2, accounts: { A: { agent: 'codex' }, B: { agent: 'codex' } }, profiles: { a: { id: 'a', account: 'A', tier: 'lite' }, b: { id: 'b', account: 'B', tier: 'lite' } }, roles: { builder: { chain: ['a'], onTierDrop: 'auto' }, worker: { chain: ['b'], onTierDrop: 'auto' } }, defaults: { cooldownMinutes: 60, transientRetries: 0, runTimeoutMinutes: 30 } };
  const deps = { agents: { codex: fake, claude: fake, opencode: fake }, config, skills: () => ({ stacks: [], skills: [], references: [], missing: [], dropped: [] }) };
  const dir = path.join(root, '.role-router', 'runs', 'TASK-001');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '001-a.json'), JSON.stringify({ operation: 'builder', role: 'builder', account: 'A', result: { kind: 'ok', summary: 'built' } }));
  writeFileSync(path.join(dir, '002-b.json'), JSON.stringify({ operation: 'review', role: 'worker', account: 'B', result: { kind: 'ok', summary: '- [MF1] a.js:1 is wrong\n\ngaps_found' } }));
  commitOn(root, 'a.js', 'main too\n', 'conflicting change');
  integrateBase(wt, 'TASK-001');
  await dispatch({ role: 'builder', task: 'TASK-001', mode: 'headless', cwd: wt }, deps);
  assert.match(prompts[0], /Review findings to address[\s\S]*\[MF1\] a\.js:1 is wrong/);
  assert.match(prompts[0], /Bring in main first/);
  writeFileSync(responsePath(root, 'TASK-001', '002-b'), '- [MF1] fixed in abc: rewrote it\n');
  git(wt, 'merge', '-q', '-X', 'ours', '-m', 'Merge main', 'main'); // the Builder resolved the conflict
  integrateBase(wt, 'TASK-001');
  await dispatch({ role: 'review', task: 'TASK-001', mode: 'headless', cwd: wt }, deps);
  assert.match(prompts.at(-1), /The previous review round[\s\S]*fixed in abc: rewrote it/);
  assert.match(prompts.at(-1), /git diff main\.\.\.HEAD/);
});

// ISSUE-RR-003: seen live, TASK-017 was cut from plan/staging-phone-otp and its Builder merged a newer
// origin/main; the review diffed against the stale plan branch and blamed TASK-017 for main's work.
function planWorld({ builderMergesMain }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-plan-'));
  const remote = mkdtempSync(path.join(os.tmpdir(), 'rr-plan-remote-'));
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  writeFileSync(path.join(root, 'PLAN.md'), '## TASK-017 — a\n- status: review\n- depends:\n');
  writeFileSync(path.join(root, 'app.config'), 'scheme=dev\n');
  writeFileSync(path.join(root, '.gitignore'), '.role-router/\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main'); git(root, 'remote', 'set-head', 'origin', 'main');
  git(root, 'checkout', '-q', '-b', 'plan/x'); commitOn(root, 'PLAN.md', '## TASK-017 — a\n- status: review\n- depends:\nreplanned\n', 'plan update'); git(root, 'push', '-q', 'origin', 'plan/x');
  const wt = ensureWorktree(root, 'TASK-017', 'plan/x', { setup: false });
  writeFileSync(path.join(wt, 'otp.js'), 'otp\n'); git(wt, 'add', 'otp.js'); git(wt, 'commit', '-qm', 'TASK-017 work');
  const other = mkdtempSync(path.join(os.tmpdir(), 'rr-plan-clone-'));
  git(other, 'clone', '-q', remote, '.');
  commitOn(other, 'app.config', 'scheme=production\n', 'upstream task: production scheme'); git(other, 'push', '-q', 'origin', 'main');
  if (builderMergesMain) { git(wt, 'fetch', '-q', 'origin'); git(wt, 'merge', '-q', '--no-edit', 'origin/main'); }
  return { root, wt };
}

test('a task that already took in newer main is reviewed and PRed against main, not its stale plan base', () => {
  const { root, wt } = planWorld({ builderMergesMain: true });
  const r = integrateBase(wt, 'TASK-017');
  assert.equal(r.target, 'origin/main');
  assert.deepEqual(r.retargeted, { from: 'plan/x', to: 'main' });
  assert.equal(readFileSync(path.join(root, '.role-router', 'worktrees', 'TASK-017.base'), 'utf8').trim(), 'main', 'the PR base follows');
  const changed = git(wt, 'diff', '--name-only', `${r.target}...HEAD`).split('\n');
  assert.ok(!changed.includes('app.config'), `main's own change is not this task's: ${changed}`);
  assert.ok(changed.includes('otp.js'));
  assert.match(integrationPrompt(wt, 'TASK-017', 'review'), /PR base is now main \(was plan\/x/);
});

test('a task that did not take in main keeps the plan branch it was cut from', () => {
  const { wt } = planWorld({ builderMergesMain: false });
  const r = integrateBase(wt, 'TASK-017');
  assert.equal(r.target, 'origin/plan/x');
  assert.equal(r.retargeted, undefined);
});

#!/usr/bin/env node

// Role Router testing ground: drives the real CLIs end to end in a throwaway sandbox.
//
//   node e2e/run.mjs                       all scenarios
//   node e2e/run.mjs --only=setup,fan      a subset
//   node e2e/run.mjs --dir=/tmp/rr-sbx     reuse / choose the sandbox location
//
// Isolation: the sandbox gets its own git repo, its own config (ROLE_ROUTER_CONFIG) and its
// own usage-limit ledger (ROLE_ROUTER_STATE_DIR). Your ~/.role-router is never read or written.
// Cost: real agent runs on your accounts, kept tiny (one-function tasks, one-sentence questions).
//
// Scenarios
//   setup   config + chains + skills per profile (dry run), repo verification skill detected
//   pstack  generated pstack rule maps panels to the sandbox profiles
//   tier    planning refuses to drop tier headless when every top account is paused (no agent spend)
//   fan     one prompt on three models (Codex, Claude Code, OpenCode), one answer each
//   loop    `role-router next TASK-001`: build → review (other vendor) → docs, statuses and evidence
//   limit   fake `claude` hits a usage limit mid-task → account paused, handoff, Codex finishes it
//   fanout  two independent tasks in parallel worktrees
//   fix     `role-router fix "<bug>"`: reproduce with a failing test, fix, review on another vendor, docs
//   guard   `role-router quick "<a redesign>"`: the Builder refuses to design on the fly (human_needed)
//   sync    merge the loop's task like a human would; sync marks it done
//   launch  `launch --detach` two tasks: returns at once, watch shows live agents, both finish the full loop
//   stop    a launched task is stopped mid-build: agent gone, handoff kept, no fallback

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposeConfig } from '../lib/setup.mjs';
import { isAlive, listActive } from '../lib/active.mjs';

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'role-router');
const args = process.argv.slice(2);
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const only = opt('only')?.split(',');
const SBX = path.resolve(opt('dir') ?? path.join(os.tmpdir(), `role-router-sandbox-${Date.now()}`));
const REPO = path.join(SBX, 'repo');
const STATE = path.join(SBX, 'state');
const CONFIG = path.join(SBX, 'config.json');
const SHIM = path.join(SBX, 'shim');

const env = (extra = {}) => ({ ...process.env, ROLE_ROUTER_CONFIG: CONFIG, ROLE_ROUTER_STATE_DIR: STATE, ROLE_ROUTER_NOTIFY: '0', ...extra });
function rr(cliArgs, { extraEnv, timeoutMin = 15 } = {}) {
  const started = Date.now();
  const r = spawnSync(CLI, cliArgs, { cwd: REPO, env: env(extraEnv), encoding: 'utf8', timeout: timeoutMin * 60_000, input: '' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), secs: Math.round((Date.now() - started) / 1000) };
}
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const status = (id) => rr(['board', 'status', id]).out.trim();
const records = (task) => {
  const dir = path.join(REPO, '.role-router', 'runs', task);
  return existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+-.*\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'))) : [];
};

// ── sandbox ────────────────────────────────────────────────────────────────────
function setUpSandbox() {
  if (existsSync(REPO)) return;
  mkdirSync(path.join(REPO, 'src'), { recursive: true });
  mkdirSync(path.join(REPO, 'test'), { recursive: true });
  writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ name: 'rr-sandbox', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
  writeFileSync(path.join(REPO, 'src', 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  // A real bug for the `fix` scenario: divides by length - 1.
  writeFileSync(path.join(REPO, 'src', 'stats.js'), 'export function average(list) {\n  return list.reduce((sum, n) => sum + n, 0) / (list.length - 1);\n}\n');
  writeFileSync(path.join(REPO, 'test', 'math.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  const task = (id, title, scope, file) => `## ${id} — ${title}
- status: planned
- depends:
### Scope
${scope}
### Interface
\`\`\`js
// ${file}
${title.includes('divide') ? 'export function divide(a, b) { throw new Error("not implemented"); } // throws RangeError on b === 0' : `export function ${title.split(' ')[1]}(a${/square|cube|negate/.test(title) ? '' : ', b'}) { throw new Error("not implemented"); }`}
\`\`\`
### Acceptance Criteria
- [ ] the function is exported from \`${file}\` with exactly the interface above
- [ ] a test in \`test/\` covers it and \`npm test\` passes
### Edge Cases
${title.includes('divide') ? 'Division by zero throws a RangeError.' : 'None beyond normal numbers.'}
### Testing Decisions
- Seam: the exported function, tested with node:test.
### Verification
Run \`npm test\`.
`;
  writeFileSync(path.join(REPO, 'PLAN.md'), `# Math helpers

Problem: the sandbox app only adds numbers. Solution: add a few more pure helpers. Out of scope: anything else.

${task('TASK-001', 'Add subtract', 'Add `subtract(a, b)` returning a - b to `src/math.js`.', 'src/math.js')}
${task('TASK-002', 'Add multiply', 'Add `multiply(a, b)` returning a * b to `src/math.js`.', 'src/math.js')}
${task('TASK-003', 'Add divide', 'Create `src/divide.js` exporting `divide(a, b)`.', 'src/divide.js')}
${task('TASK-004', 'Add square', 'Create `src/square.js` exporting `square(a)` returning a * a.', 'src/square.js')}
${task('TASK-005', 'Add cube', 'Create `src/cube.js` exporting `cube(a)` returning a * a * a.', 'src/cube.js')}
${task('TASK-006', 'Add negate', 'Create `src/negate.js` exporting `negate(a)` returning -a.', 'src/negate.js')}`);
  const verify = path.join(REPO, '.claude', 'skills', 'verify-sandbox');
  mkdirSync(verify, { recursive: true });
  writeFileSync(path.join(verify, 'SKILL.md'), `---
name: verify-sandbox
description: Drive the sandbox math library the way a caller does and capture evidence.
---
# Verify sandbox
- Launch: nothing to start; this is a library.
- Doctor: \`node -e "import('./src/math.js').then(m => console.log(Object.keys(m)))"\` lists the exports.
- Drive: call the changed function from a one-off \`node -e\` script with real inputs, the way a caller would.
- Evidence: write the command and its output to \`.verify/<TASK-id>.txt\`.
- Cleanup: none.
`);
  writeFileSync(path.join(REPO, '.gitignore'), 'node_modules/\n.verify/\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: REPO });
  execFileSync('git', ['add', '-A'], { cwd: REPO });
  execFileSync('git', ['-c', 'user.email=sandbox@local', '-c', 'user.name=sandbox', 'commit', '-q', '-m', 'sandbox'], { cwd: REPO });

  const config = proposeConfig([
    { id: 'openai', agent: 'codex', topModel: '', liteModel: '' },
    { id: 'anthropic', agent: 'claude', topModel: 'opus', liteModel: 'sonnet' },
    { id: 'ocgo', agent: 'opencode', provider: 'opencode', liteModel: 'opencode/big-pickle' }, // free model: works without a paid OpenCode plan
  ], { executionOrder: ['anthropic', 'openai', 'ocgo'] });
  config.defaults.transientRetries = 1;
  writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');

  // A fake `claude` that is signed in but out of usage: the only way to exercise a real limit on demand.
  mkdirSync(SHIM, { recursive: true });
  const reset = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(path.join(SHIM, 'claude'), `#!/usr/bin/env bash
case "$1" in
  --version) echo "2.1.289 (Claude Code)"; exit 0 ;;
  auth) echo '{ "loggedIn": true }'; exit 0 ;;
esac
echo '{"type":"system","subtype":"init","session_id":"shim-session"}'
echo '{"type":"assistant","session_id":"shim-session","message":{"content":[{"type":"text","text":"Reading the spec for the task; starting on the implementation."}]}}'
echo '{"type":"rate_limit_event","session_id":"shim-session","rate_limit_info":{"status":"rejected","resetsAt":${reset},"rateLimitType":"five_hour"}}'
echo '{"type":"result","is_error":true,"session_id":"shim-session","result":"You have hit your limit · resets later"}'
exit 1
`);
  chmodSync(path.join(SHIM, 'claude'), 0o755);
}

// ── scenarios ──────────────────────────────────────────────────────────────────
const scenarios = {
  setup() {
    const checks = [];
    const builder = rr(['run', 'builder', 'TASK-001', '--dry-run']);
    const chain = JSON.parse(builder.out.slice(builder.out.indexOf('{'))).chain;
    checks.push(['builder chain is anthropic-lite → openai-lite → ocgo-lite → tops', chain.map((p) => p.profile).join(' → ').startsWith('anthropic-lite → openai-lite → ocgo-lite')]);
    checks.push(['every builder profile gets tdd, diagnosing-bugs and the repo verify-sandbox skill', chain.every((p) => ['tdd', 'diagnosing-bugs', 'verify-sandbox'].every((s) => p.skills.includes(s)))]);
    const arch = JSON.parse(rr(['run', 'architect', 'x', '--dry-run']).out.split('\n').slice(0).join('\n').replace(/^[^{]*/, '')).chain;
    checks.push(['architect starts on top profiles and gets grilling', arch[0].profile.endsWith('-top') && arch[0].skills.includes('grilling') && !arch[0].skills.includes('verify-sandbox')]);
    checks.push(['every architect profile gets the architect references for the design round', arch.every((p) => p.references.includes('architect'))]);
    checks.push(['launch commands match each agent', chain.find((p) => p.profile === 'ocgo-lite').command === 'opencode' && chain.find((p) => p.profile === 'openai-lite').command === 'codex']);
    return checks;
  },

  pstack() {
    const r = rr(['pstack', '--print']);
    return [
      ['arena runners = one top/lite profile per account', /arena runners: role-router:openai-top, role-router:anthropic-top, role-router:ocgo-lite/.test(r.out)],
      ['how explorer = preferred execution profile', /how explorer: role-router:anthropic-lite/.test(r.out)],
      ['rule tells the agent to use fan, not Task slugs', /role-router fan --profiles=/.test(r.out) && /NOT Task model slugs/.test(r.out)],
    ];
  },

  tier() {
    rr(['limits', 'pause', 'openai', '--until=+20m']);
    rr(['limits', 'pause', 'anthropic', '--until=+20m']);
    const r = rr(['run', 'architect', 'plan something', '--headless']);
    rr(['limits', 'clear', 'openai']);
    rr(['limits', 'clear', 'anthropic']);
    return [
      ['headless planning exits 2 (needs a decision) instead of dropping tier', r.code === 2],
      ['it explains the choice', /top-tier architect profiles are unavailable/.test(r.out) && /switch to ocgo-lite/.test(r.out)],
    ];
  },

  fan() {
    const r = rr(['fan', '--timeout=4', 'In one sentence: what does it mean for an operation to be idempotent?'], { timeoutMin: 15 });
    const index = /index: (.*fan\.json)/.exec(r.out)?.[1];
    const lanes = index ? JSON.parse(readFileSync(index, 'utf8')).lanes : [];
    const answered = lanes.filter((l) => l.status === 'ok' && readFileSync(l.answer, 'utf8').trim().length > 20);
    return [
      ['three lanes (Codex, Claude Code, OpenCode)', lanes.length === 3],
      ['every lane answered', answered.length === 3, lanes.map((l) => `${l.profile}:${l.status}${l.message ? ` (${l.message})` : ''}`).join(', ')],
    ];
  },

  loop() {
    const r = rr(['next', 'TASK-001'], { timeoutMin: 30 });
    const recs = records('TASK-001');
    const by = (op) => recs.filter((x) => (x.operation ?? x.role) === op && x.result.kind === 'ok').at(-1);
    const built = by('builder');
    const reviewed = by('review');
    let testsPass = false;
    const wt1 = path.join(REPO, '.role-router', 'worktrees', 'TASK-001');
    try { execFileSync('npm', ['test', '--silent'], { cwd: wt1, stdio: 'ignore' }); testsPass = true; } catch { /* reported below */ }
    return [
      ['next exits 0 and stops at passed', r.code === 0 && /passed:/.test(r.out), r.out.trim().split('\n').slice(-2).join(' | ')],
      ['TASK-001 status is passed', status('TASK-001') === 'passed', `status: ${status('TASK-001')}`],
      ['builder, review and docs each ran ok', Boolean(built && reviewed && by('docs'))],
      ['review ran on a different account than the build', Boolean(built && reviewed && built.account !== reviewed.account), `${built?.account} → ${reviewed?.account}`],
      ['run records carry git evidence', recs.every((x) => x.evidence && typeof x.evidence.uncommittedFiles === 'number')],
      ['task branch has a commit and npm test passes on it', testsPass],
      ['the working tree is clean after the loop (status lives outside git)', !git('status', '--porcelain').includes('PLAN.md')],
      ['the main checkout never left main (the task ran in its worktree)', git('branch', '--show-current') === 'main'],
      ['role-router pr plans the PR from the task branch into main', /task\/TASK-001 → main/.test(rr(['pr', 'TASK-001', '--dry-run']).out)],
      ['builder left verification evidence (.verify/TASK-001.txt)', [wt1, REPO].some((d) => existsSync(path.join(d, '.verify', 'TASK-001.txt'))), 'soft check: prompt-driven'],
    ];
  },

  limit() {
    git('checkout', '-q', 'main');
    const r = rr(['run', 'builder', 'TASK-002', '--headless'], { extraEnv: { PATH: `${SHIM}:${process.env.PATH}` }, timeoutMin: 20 });
    const recs = records('TASK-002');
    const ledger = JSON.parse(readFileSync(path.join(STATE, 'accounts.json'), 'utf8'));
    const dir = path.join(REPO, '.role-router', 'runs', 'TASK-002');
    const handoff = ['handoff.done.md', 'handoff.md'].map((f) => path.join(dir, f)).find(existsSync);
    rr(['limits', 'clear', 'anthropic']);
    return [
      ['fake Claude run classified as usage_limit, then Codex finished', recs[0]?.result.kind === 'usage_limit' && recs.at(-1)?.result.kind === 'ok' && recs.at(-1)?.account === 'openai', recs.map((x) => `${x.profile}:${x.result.kind}`).join(' → ')],
      ['anthropic paused until the reset the agent reported', Boolean(ledger.anthropic?.pausedUntil) && ledger.anthropic.seenOn === 'TASK-002'],
      ['session id captured for a later resume', recs[0]?.result.sessionId === 'shim-session'],
      ['handoff written (and archived after success)', Boolean(handoff) && /Last words of the previous agent[\s\S]*starting on the implementation/.test(readFileSync(handoff, 'utf8'))],
      ['run exit 0, TASK-002 moved to review', r.code === 0 && status('TASK-002') === 'review', `exit ${r.code}, status ${status('TASK-002')}`],
    ];
  },

  fanout() {
    git('checkout', '-q', 'main');
    const r = rr(['fanout', '--yes', '--base=main', 'TASK-003', 'TASK-004'], { timeoutMin: 30 });
    const wt = (id) => path.join(REPO, '.role-router', 'worktrees', id);
    const ok = (id) => existsSync(path.join(wt(id), '.git')) && records(id).some((x) => x.result.kind === 'ok');
    return [
      ['fanout exits 0', r.code === 0, r.out.trim().split('\n').slice(-6).join(' | ')],
      ['each task built in its own worktree', ok('TASK-003') && ok('TASK-004')],
      ['the main board sees both tasks in review', status('TASK-003') === 'review' && status('TASK-004') === 'review', `TASK-003 ${status('TASK-003')}, TASK-004 ${status('TASK-004')}`],
      ['no worktree left a dirty PLAN.md', ['TASK-003', 'TASK-004'].every((id) => !execFileSync('git', ['status', '--porcelain'], { cwd: wt(id), encoding: 'utf8' }).includes('PLAN.md'))],
      ['both task branches exist', ['task/TASK-003', 'task/TASK-004'].every((b) => { try { git('rev-parse', '--verify', b); return true; } catch { return false; } })],
    ];
  },

  fix() {
    git('checkout', '-q', 'main');
    const r = rr(['fix', 'average([2, 4]) in src/stats.js returns 6 instead of 3'], { timeoutMin: 30 });
    const recs = records('FIX-001');
    const by = (op) => recs.filter((x) => (x.operation ?? x.role) === op && x.result.kind === 'ok').at(-1);
    let fixed = false;
    let suite = false;
    let testMentions = false;
    try {
      const wtf = path.join(REPO, '.role-router', 'worktrees', 'FIX-001');
      fixed = execFileSync('node', ['-e', "import('./src/stats.js').then(m => console.log(m.average([2, 4])))"], { cwd: wtf, encoding: 'utf8' }).trim() === '3';
      execFileSync('npm', ['test', '--silent'], { cwd: wtf, stdio: 'ignore' }); suite = true;
      testMentions = /average/.test(git('diff', 'main', 'task/FIX-001', '--', 'test'));
    } catch { /* reported below */ }
    const notes = readFileSync(path.join(REPO, '.role-router', 'tasks', 'FIX-001.md'), 'utf8').split('### Notes')[1] ?? '';
    return [
      ['fix exits 0 and the task passes', r.code === 0 && status('FIX-001') === 'passed', `exit ${r.code}, status ${status('FIX-001')}`],
      ['the bug is fixed on task/FIX-001 and the suite passes', fixed && suite],
      ['a test covering average was added', testMentions],
      ['the Builder wrote its reproduction / root cause under Notes', notes.replace(/\(Builder:[^)]*\)/, '').trim().length > 20],
      ['review ran on another account than the build', Boolean(by('builder') && by('review') && by('builder').account !== by('review').account), `${by('builder')?.account} → ${by('review')?.account}`],
    ];
  },

  guard() {
    git('checkout', '-q', 'main');
    const r = rr(['quick', 'replace the whole math library with a pluggable plugin architecture and a new public API'], { timeoutMin: 20 });
    return [
      ['quick on a redesign stops with human_needed (exit 2)', r.code === 2 && status('QUICK-001') === 'human_needed', `exit ${r.code}, status ${status('QUICK-001')}`],
      ['no review ran on it', !records('QUICK-001').some((x) => (x.operation ?? x.role) === 'review')],
      ['it points the user to /plan', /run architect/.test(r.out)],
      ['it is in the inbox with a question', (() => { const inbox = rr(['inbox']).out; return /QUICK-001\s+\[\w[\w-]*\]/.test(inbox); })()],
      ['resolve records a decision for it', /Decision recorded for repo:QUICK-001/.test(rr(['resolve', 'QUICK-001', '--note', 'keep the current API; out of scope', '--no-run']).out)],
    ];
  },

  sync() {
    // Merge the loop's passed TASK-001 the way a human would, then sync.
    git('checkout', '-q', 'main');
    const before = status('TASK-001');
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', '--no-ff', 'task/TASK-001', '-m', 'merge TASK-001'], { cwd: REPO });
    const out = rr(['sync']).out;
    return [
      ['TASK-001 was passed before the merge', before === 'passed', `was ${before}`],
      ['sync marks the merged task done', status('TASK-001') === 'done' && /done → TASK-001/.test(out), out.trim()],
    ];
  },

  launch() {
    git('checkout', '-q', 'main');
    const started = Date.now();
    const r = rr(['launch', '--yes', '--detach', 'TASK-005', 'TASK-006']);
    const returnedIn = (Date.now() - started) / 1000;
    const id = /Launch (L\S+)/.exec(r.out)?.[1];
    const file = path.join(STATE, 'launches', `${id}.json`);
    let sawLive = false;
    let record;
    for (let i = 0; i < 300; i++) {
      sleep(5000);
      const screen = rr(['watch', '--once']).out;
      if (/TASK-00[56]\s+(builder|review|docs)\s+\S+-(lite|top)\s+\d/.test(screen)) sawLive = true;
      record = JSON.parse(readFileSync(file, 'utf8'));
      if (record.tasks.every((t) => ['done', 'stopped'].includes(t.state))) break;
    }
    const recs = (t) => records(t);
    const crossVendor = ['TASK-005', 'TASK-006'].every((t) => {
      const b = recs(t).filter((x) => x.role === 'builder' && x.result.kind === 'ok').at(-1);
      const v = recs(t).filter((x) => x.operation === 'review' && x.result.kind === 'ok').at(-1);
      return b && v && b.account !== v.account;
    });
    return [
      ['launch --detach returns immediately with a launch id', r.code === 0 && Boolean(id) && returnedIn < 15, `${returnedIn.toFixed(1)}s, ${id}`],
      ['watch showed live agents while they worked', sawLive],
      ['both tasks finished the full loop (passed)', record?.tasks.every((t) => t.stop === 'passed'), record?.tasks.map((t) => `${t.id}:${t.stop ?? t.state}`).join(', ')],
      ['each ran in its own worktree, reviewed on another vendor', ['TASK-005', 'TASK-006'].every((t) => existsSync(path.join(REPO, '.role-router', 'worktrees', t, '.git'))) && crossVendor],
    ];
  },

  stop() {
    git('checkout', '-q', 'main');
    const id = /(QUICK-\d+) created/.exec(rr(['quick', '--no-run', 'add cbrt(a), the cube root, in a new src/cbrt.js with a test']).out)?.[1];
    const r = rr(['launch', '--yes', '--detach', id]);
    const launchId = /Launch (L\S+)/.exec(r.out)?.[1];
    let marker;
    for (let i = 0; i < 90 && !marker; i++) { sleep(2000); marker = listActive(REPO).find((a) => a.task === id && !a.stale); }
    sleep(4000);
    const stopOut = rr(['stop', id]).out;
    let record;
    for (let i = 0; i < 60; i++) {
      sleep(2000);
      record = JSON.parse(readFileSync(path.join(STATE, 'launches', `${launchId}.json`), 'utf8'));
      if (record.tasks.every((t) => ['done', 'stopped'].includes(t.state))) break;
    }
    const lane = record?.tasks[0];
    const runs = records(id);
    return [
      ['the launched agent was visible before the stop', Boolean(marker), marker ? `${marker.profile} pid ${marker.pid}` : 'never seen'],
      ['stop ended the lane as stopped by the user', lane?.stop === 'aborted' && /stopped by user/.test(lane?.message ?? ''), `${lane?.stop}: ${lane?.message}`],
      ['the agent process is gone and its marker removed', Boolean(marker) && !isAlive(marker.pid) && !listActive(REPO).some((a) => a.task === id)],
      ['no fallback to another profile after the stop', runs.length === 1 && runs[0].result.kind === 'stopped', runs.map((x) => `${x.profile}:${x.result.kind}`).join(' → ')],
      ['handoff kept for a later resume', existsSync(path.join(REPO, '.role-router', 'runs', id, 'handoff.md')), stopOut.trim()],
    ];
  },
};

// ── run ────────────────────────────────────────────────────────────────────────
setUpSandbox();
console.log(`sandbox: ${SBX}\n`);
const results = [];
for (const [name, fn] of Object.entries(scenarios)) {
  if (only && !only.includes(name)) continue;
  const started = Date.now();
  let checks;
  try { checks = fn(); } catch (e) { checks = [[`scenario crashed: ${e.message}`, false]]; }
  const secs = Math.round((Date.now() - started) / 1000);
  for (const [label, pass, detail] of checks) results.push({ scenario: name, label, pass, detail });
  const failed = checks.filter(([, p]) => !p).length;
  console.log(`${failed ? '✗' : '✓'} ${name} (${secs}s)`);
  for (const [label, pass, detail] of checks) console.log(`    ${pass ? '✓' : '✗'} ${label}${detail ? `  [${detail}]` : ''}`);
}
const report = path.join(SBX, 'report.json');
writeFileSync(report, JSON.stringify(results, null, 2) + '\n');
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Report: ${report}`);
process.exitCode = failed.length ? 1 : 0;

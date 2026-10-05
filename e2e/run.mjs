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

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposeConfig } from '../lib/setup.mjs';

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

const env = (extra = {}) => ({ ...process.env, ROLE_ROUTER_CONFIG: CONFIG, ROLE_ROUTER_STATE_DIR: STATE, ...extra });
function rr(cliArgs, { extraEnv, timeoutMin = 15 } = {}) {
  const started = Date.now();
  const r = spawnSync(CLI, cliArgs, { cwd: REPO, env: env(extraEnv), encoding: 'utf8', timeout: timeoutMin * 60_000, input: '' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), secs: Math.round((Date.now() - started) / 1000) };
}
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const status = (id) => /- status:\s*(\S+)/.exec(readFileSync(path.join(REPO, 'PLAN.md'), 'utf8').split(`## ${id}`)[1] ?? '')?.[1];
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
  writeFileSync(path.join(REPO, 'test', 'math.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  const task = (id, title, scope, file) => `## ${id} — ${title}
- status: planned
- depends:
### Scope
${scope}
### Interface
\`\`\`js
// ${file}
${title.includes('divide') ? 'export function divide(a, b) { throw new Error("not implemented"); } // throws RangeError on b === 0' : `export function ${title.split(' ')[1]}(a${title.includes('square') ? '' : ', b'}) { throw new Error("not implemented"); }`}
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
${task('TASK-004', 'Add square', 'Create `src/square.js` exporting `square(a)` returning a * a.', 'src/square.js')}`);
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
  config.defaults.transientRetries = 0;
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
    const r = rr(['fan', 'In one sentence: what does it mean for an operation to be idempotent?'], { timeoutMin: 10 });
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
    try { git('checkout', '-q', 'task/TASK-001'); execFileSync('npm', ['test', '--silent'], { cwd: REPO, stdio: 'ignore' }); testsPass = true; } catch { /* reported below */ }
    return [
      ['next exits 0 and stops at passed', r.code === 0 && /passed:/.test(r.out), r.out.trim().split('\n').slice(-2).join(' | ')],
      ['TASK-001 status is passed', status('TASK-001') === 'passed', `status: ${status('TASK-001')}`],
      ['builder, review and docs each ran ok', Boolean(built && reviewed && by('docs'))],
      ['review ran on a different account than the build', Boolean(built && reviewed && built.account !== reviewed.account), `${built?.account} → ${reviewed?.account}`],
      ['run records carry git evidence', recs.every((x) => x.evidence && typeof x.evidence.uncommittedFiles === 'number')],
      ['task branch has a commit and npm test passes on it', testsPass],
      ['builder left verification evidence (.verify/TASK-001.txt)', existsSync(path.join(REPO, '.verify', 'TASK-001.txt')), 'soft check: prompt-driven'],
    ];
  },

  limit() {
    try { git('checkout', '-q', 'main'); } catch { /* already there */ }
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
    try { git('checkout', '-q', 'main'); } catch { /* already there */ }
    const r = rr(['fanout', '--yes', '--base=main', 'TASK-003', 'TASK-004'], { timeoutMin: 30 });
    const wt = (id) => path.join(REPO, '.role-router', 'worktrees', id);
    const ok = (id) => existsSync(path.join(wt(id), '.git')) && records(id).some((x) => x.result.kind === 'ok');
    return [
      ['fanout exits 0', r.code === 0, r.out.trim().split('\n').slice(-6).join(' | ')],
      ['each task built in its own worktree', ok('TASK-003') && ok('TASK-004')],
      ['both task branches exist', ['task/TASK-003', 'task/TASK-004'].every((b) => { try { git('rev-parse', '--verify', b); return true; } catch { return false; } })],
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

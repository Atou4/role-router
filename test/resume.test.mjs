import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codex } from '../lib/agents/codex.mjs';
import { loadBoard, setStatus } from '../lib/board.mjs';
import { dispatch } from '../lib/dispatch.mjs';
import { resumeStatus, runNext } from '../lib/next.mjs';
import { classifyWip, recordWip, wipPrompt } from '../lib/wip.mjs';

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' });
function repo(status = 'planned') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-resume-'));
  writeFileSync(path.join(root, 'PLAN.md'), `## TASK-001 — a\n- status: ${status}\n- depends:\n`);
  writeFileSync(path.join(root, 'app.js'), 'export const a = 1;\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  return root;
}
const records = (root, ...ops) => {
  const dir = path.join(root, '.role-router', 'runs', 'TASK-001');
  mkdirSync(dir, { recursive: true });
  ops.forEach((operation, i) => writeFileSync(path.join(dir, `00${i + 1}-p.json`), JSON.stringify({ operation, result: { kind: 'ok' } })));
};

test('a decided task resumes at the stage that stopped, never an earlier one', () => {
  const cases = [
    [['builder', 'review'], 'human_needed', 'review'],     // the reviewer asked: re-review with the decision
    [['builder', 'review', 'docs'], 'human_needed', 'passed'], // docs stopped: docs again
    [['builder'], 'human_needed', 'gaps_found'],           // the builder stopped: build again
    [['builder', 'escalation'], 'building', 'gaps_found'],
    [[], 'human_needed', 'planned'],
    [['builder', 'review'], 'passed', 'passed'],           // never rewind a passed task
    [['builder', 'review'], 'review', 'review'],
    [['builder', 'review'], 'gaps_found', 'gaps_found'],   // review gaps: the fix is a build
  ];
  for (const [ops, status, want] of cases) {
    const root = repo(status);
    records(root, ...ops);
    assert.equal(resumeStatus(root, 'TASK-001', status), want, `${ops.join('→')} at ${status}`);
  }
});

test('stopping a run puts the board back where it was', async () => {
  const root = repo('passed');
  // Seen live: a needless rebuild of a passed task was stopped and left it at gaps_found.
  setStatus(root, 'TASK-001', 'gaps_found');
  const stopped = async ({ task }) => { setStatus(root, task, 'building'); return { status: 'aborted', message: 'stopped by user', runs: [{ profile: 'p' }] }; };
  const r = await runNext({ root, task: 'TASK-001', dispatch: stopped, policy: { notify: false } });
  assert.equal(r.stop, 'aborted');
  assert.equal(loadBoard(root).byId.get('TASK-001').status, 'gaps_found', 'back to the status before the stopped run, not building');
});

test("a run's uncommitted work is the next run's to continue; anything else is unexplained", () => {
  const root = repo();
  writeFileSync(path.join(root, 'app.js'), 'export const a = 2;\n');
  writeFileSync(path.join(root, 'new.js'), 'export const b = 1;\n');
  recordWip(root, 'TASK-001', root, '003-anthropic-lite');
  assert.deepEqual(classifyWip(root, 'TASK-001', root), { own: [{ file: 'app.js', run: '003-anthropic-lite' }, { file: 'new.js', run: '003-anthropic-lite' }], unexplained: [] });
  assert.match(wipPrompt(root, 'TASK-001', root), /Work in progress from earlier runs[\s\S]*app\.js \(left by run 003-anthropic-lite\)[\s\S]*precondition is satisfied/);

  // Someone edits after the run, and a tracked file changes that no run left: both unexplained.
  writeFileSync(path.join(root, 'app.js'), 'export const a = 3;\n');
  writeFileSync(path.join(root, 'PLAN.md'), 'edited by hand\n');
  writeFileSync(path.join(root, 'stray.txt'), 'untracked, not ours\n');
  const c = classifyWip(root, 'TASK-001', root);
  assert.deepEqual(c.unexplained.sort(), ['PLAN.md', 'app.js']);
  assert.deepEqual(c.own.map((o) => o.file), ['new.js']);
  assert.match(wipPrompt(root, 'TASK-001', root), /Unexplained changes[\s\S]*PLAN\.md/);

  // The next run picks the edits up as its own once it ends with them.
  recordWip(root, 'TASK-001', root, '004-openai-top');
  assert.equal(classifyWip(root, 'TASK-001', root).unexplained.length, 0);
  assert.equal(classifyWip(root, 'TASK-001', root).own.find((o) => o.file === 'new.js').run, '003-anthropic-lite', 'unchanged files keep the run that left them');
});

test('dispatch records what a run leaves and hands it to the next run', async () => {
  const root = repo('planned');
  const prompts = [];
  let edit = true;
  const fake = { ...codex, preflight: () => null, launch: (p, a, prompt, { cwd }) => {
    prompts.push(prompt);
    if (edit) { writeFileSync(path.join(cwd, 'app.js'), 'export const a = 42;\n'); edit = false; }
    return { command: process.execPath, args: ['-e', 'console.log(JSON.stringify({type:"turn.completed",usage:{}}))'] };
  } };
  const config = { version: 2, accounts: { A: { agent: 'codex' } }, profiles: { a: { id: 'a', account: 'A', tier: 'lite' } }, roles: { builder: { chain: ['a'], onTierDrop: 'auto' }, escalation: { chain: ['a'], onTierDrop: 'auto' } }, defaults: { cooldownMinutes: 60, transientRetries: 0, runTimeoutMinutes: 30 } };
  const deps = { agents: { codex: fake, claude: fake, opencode: fake }, config, skills: () => ({ stacks: [], skills: [], references: [], missing: [], dropped: [] }) };
  // The fake edits during launch(), before the prompt is used: the first run sees nothing yet.
  await dispatch({ role: 'builder', task: 'TASK-001', mode: 'headless', cwd: root }, deps);
  await dispatch({ role: 'escalation', task: 'TASK-001', mode: 'headless', cwd: root }, deps);
  assert.match(prompts[1], /Work in progress from earlier runs on TASK-001[\s\S]*app\.js \(left by run 001-a\)/);
});

// A fake agent that starts a background process sharing its output pipe, writes that pid, then
// either finishes or hangs.
const leaky = (pidFile, { hang = false } = {}) => ({
  ...codex, preflight: () => null,
  launch: () => ({ command: process.execPath, args: ['-e', `
    const { spawn } = require('node:child_process');
    const bg = spawn('sleep', ['60'], { stdio: 'inherit' });
    bg.unref();
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(bg.pid));
    console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
    ${hang ? 'setInterval(() => {}, 1000);' : ''}
  `] }),
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const leakConfig = { version: 2, accounts: { A: { agent: 'codex' } }, profiles: { a: { id: 'a', account: 'A', tier: 'lite' } }, roles: { builder: { chain: ['a'], onTierDrop: 'auto' } }, defaults: { cooldownMinutes: 60, transientRetries: 0, runTimeoutMinutes: 30 } };
const noSkills = () => ({ stacks: [], skills: [], references: [], missing: [], dropped: [] });

test('a finished agent ends its run even when it left a process holding its output', async () => {
  const root = repo('planned');
  const pidFile = path.join(root, 'bg.pid');
  const agent = leaky(pidFile);
  const started = Date.now();
  const out = await dispatch({ role: 'builder', task: 'TASK-001', mode: 'headless', cwd: root }, { agents: { codex: agent, claude: agent, opencode: agent }, config: leakConfig, skills: noSkills });
  assert.equal(out.status, 'ok');
  assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started}ms; the background sleep would hold it 60s`);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false, 'what the agent left running is ended');
});

test('a timed-out agent is killed with everything it started', async () => {
  const root = repo('planned');
  const pidFile = path.join(root, 'bg.pid');
  const agent = leaky(pidFile, { hang: true });
  const out = await dispatch({ role: 'builder', task: 'TASK-001', mode: 'headless', cwd: root, timeoutMinutes: 0.03 }, { agents: { codex: agent, claude: agent, opencode: agent }, config: leakConfig, skills: noSkills });
  assert.match(out.runs.at(-1).result.message, /no result after/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false);
});

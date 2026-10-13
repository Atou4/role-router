import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codex } from '../lib/agents/codex.mjs';
import { listActive, requestStop } from '../lib/active.mjs';
import { dispatch } from '../lib/dispatch.mjs';
import { createLaunch, readLaunch, resolveTargets, runLaunch } from '../lib/launch.mjs';
import { describeEvent, render } from '../lib/watch.mjs';
import { handoffPath } from '../lib/runs.mjs';

function repo(name, plan, parent = mkdtempSync(path.join(os.tmpdir(), 'rr-launch-'))) {
  const root = path.join(parent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'PLAN.md'), plan);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

test('stop: a running agent ends within seconds, the next profile is not tried, the handoff is kept', async () => {
  const root = repo('r', '## TASK-001 — t\n- status: building\n- depends:\n');
  const hang = { ...codex, preflight: () => null, launch: () => ({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] }) };
  const ok = { ...codex, preflight: () => null, launch: () => ({ command: process.execPath, args: ['-e', 'process.exit(0)'] }) };
  const config = {
    version: 2,
    accounts: { A: { agent: 'codex' }, B: { agent: 'claude' } },
    profiles: { a: { id: 'a', account: 'A', tier: 'lite' }, b: { id: 'b', account: 'B', tier: 'lite' } },
    roles: { builder: { chain: ['a', 'b'], onTierDrop: 'auto' } },
    defaults: { cooldownMinutes: 60, transientRetries: 2, runTimeoutMinutes: 30 },
  };
  const started = Date.now();
  const running = dispatch({ role: 'builder', task: 'TASK-001', mode: 'headless', cwd: root },
    { agents: { codex: hang, claude: ok }, config, sleep: async () => {}, skills: () => ({ stacks: [], skills: [], references: [], missing: [], dropped: [] }) });
  await new Promise((r) => setTimeout(r, 800));
  const active = listActive(root);
  assert.equal(active.length, 1, 'the running agent is visible to watch');
  assert.equal(active[0].profile, 'a');
  requestStop(root, 'TASK-001');
  const out = await running;
  assert.ok(Date.now() - started < 10000);
  assert.equal(out.status, 'aborted');
  assert.equal(out.message, 'stopped by user');
  assert.deepEqual(out.runs.map((r) => r.profile), ['a'], 'no fallback after a stop');
  assert.ok(existsSync(handoffPath(root, 'TASK-001')));
  assert.equal(listActive(root).length, 0, 'marker removed');
});

test('launch targets: across repos by name, refused when not buildable (cross-repo deps included)', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'rr-ws-'));
  const server = repo('Server', '## TASK-001 — a\n- status: planned\n- depends:\n\n## TASK-012 — b\n- status: planned\n- depends: App:TASK-101\n', parent);
  repo('App', '## TASK-101 — c\n- status: planned\n- depends:\n', parent);
  const t = resolveTargets(['TASK-001', 'App:TASK-101'], { cwd: server });
  assert.deepEqual(t.map((x) => `${x.repo}:${x.id}`), ['Server:TASK-001', 'App:TASK-101']);
  assert.throws(() => resolveTargets(['TASK-012'], { cwd: server }), /Server:TASK-012: depends on App:TASK-101/);
  assert.throws(() => resolveTargets(['Nope:TASK-1'], { cwd: server }), /no repo named "Nope"/);
});

test('runLaunch: concurrency cap, record kept up to date, a queued task with a stop request never starts', async () => {
  const root = repo('r', ['001', '002', '003', '004'].map((n) => `## TASK-${n} — t\n- status: planned\n- depends:\n`).join('\n'));
  const targets = ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004'].map((id) => ({ repoRoot: root, repo: 'r', id }));
  const rec = createLaunch(targets, { concurrency: 2 });
  requestStop(root, 'TASK-004');
  let live = 0; let peak = 0; const ran = [];
  const lane = async (t) => { live++; peak = Math.max(peak, live); ran.push(t.id); await new Promise((r) => setTimeout(r, 50)); live--; return { stop: 'passed', message: 'ok' }; };
  const done = await runLaunch(rec.id, { lane });
  assert.equal(peak, 2);
  assert.deepEqual(ran.sort(), ['TASK-001', 'TASK-002', 'TASK-003']);
  assert.deepEqual(done.tasks.map((t) => t.state), ['done', 'done', 'done', 'stopped']);
  assert.equal(readLaunch(rec.id).tasks[0].stop, 'passed');
});

test('watch: events from all three agents become one readable line; the screen lists running and queued work', () => {
  assert.equal(describeEvent('{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}'), 'ran npm test');
  assert.equal(describeEvent('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/a.js"}}]}}'), 'Edit src/a.js');
  assert.equal(describeEvent('{"type":"text","part":{"text":"Implemented divide."}}'), 'Implemented divide.');
  assert.equal(describeEvent('not json'), null);
  const now = new Date('2026-10-12T12:10:00Z');
  const screen = render({
    now,
    accounts: [{ account: 'openai', pausedUntil: null }, { account: 'anthropic', pausedUntil: '2026-10-12T13:00:00Z', reason: 'usage limit' }],
    active: [{ repo: 'Server', repoRoot: '/s', task: 'TASK-001', operation: 'builder', profile: 'openai-lite', startedAt: '2026-10-12T12:04:00Z', last: 'ran npm test' }],
    launches: [{ id: 'L1', running: true, pid: 42, startedAt: '2026-10-12T12:00:00Z', tasks: [
      { repoRoot: '/s', repo: 'Server', id: 'TASK-001', state: 'running' },
      { repoRoot: '/a', repo: 'App', id: 'TASK-101', state: 'queued' },
    ] }],
  });
  assert.match(screen, /anthropic paused until/);
  assert.match(screen, /Server\s+TASK-001\s+builder\s+openai-lite\s+6m00s\s+ran npm test/);
  assert.match(screen, /App\s+TASK-101\s+queued/);
  assert.match(screen, /launches running: L1/);
});

test('limits: a launch lane waits for the reset and resumes instead of ending', async () => {
  const root = repo('r', '## TASK-001 — t\n- status: planned\n- depends:\n');
  const rec = createLaunch([{ repoRoot: root, repo: 'r', id: 'TASK-001' }], { concurrency: 1 });
  let clock = 1_000_000;
  const results = [{ stop: 'waiting', resumeAt: new Date(clock + 60_000), message: 'every usable builder profile is limited' }, { stop: 'passed', message: 'ok' }];
  let calls = 0;
  const done = await runLaunch(rec.id, {
    lane: async () => { calls++; return results.shift(); },
    policy: { waitForLimits: true },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(calls, 2);
  assert.equal(done.tasks[0].stop, 'passed');
});

test('limits: a stop request ends the wait', async () => {
  const root = repo('r', '## TASK-001 — t\n- status: planned\n- depends:\n');
  const rec = createLaunch([{ repoRoot: root, repo: 'r', id: 'TASK-001' }], { concurrency: 1 });
  let clock = 1_000_000;
  const done = await runLaunch(rec.id, {
    lane: async () => ({ stop: 'waiting', resumeAt: new Date(clock + 3_600_000), message: 'limited' }),
    policy: { waitForLimits: true },
    now: () => clock,
    sleep: async (ms) => { clock += ms; if (clock > 1_020_000) requestStop(root, 'TASK-001'); },
  });
  assert.equal(done.tasks[0].stop, 'aborted');
  assert.match(done.tasks[0].message, /while waiting/);
});

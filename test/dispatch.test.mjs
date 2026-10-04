import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codex } from '../lib/agents/codex.mjs';
import { accountStates } from '../lib/accounts.mjs';
import { dispatch } from '../lib/dispatch.mjs';
import { handoffPath } from '../lib/runs.mjs';

// Fake agents: real Codex classifier, but the "CLI" is a node one-liner chosen by profile.model.
const SCRIPTS = {
  ok: `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));console.log('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}')`,
  limit: `console.log(JSON.stringify({type:'turn.failed',error:{message:"You've hit your usage limit. Try again in 2 hours."}}));process.exit(1)`,
  crash: `process.exit(2)`,
};
const fake = { ...codex, preflight: () => null, launch: (profile) => ({ command: process.execPath, args: ['-e', SCRIPTS[profile.model]] }) };
const agents = { codex: fake, claude: fake, opencode: fake };

const profile = (id, account, model, tier) => [id, { id, account, model, tier }];
const config = (roles, profiles) => ({
  version: 2,
  accounts: { A: { agent: 'codex' }, B: { agent: 'claude' } },
  profiles: Object.fromEntries(profiles),
  roles,
  defaults: { cooldownMinutes: 60, transientRetries: 0 },
});

let cwd;
const t0 = new Date('2026-10-04T12:00:00Z');
const base = (over) => ({ mode: 'headless', get cwd() { return cwd; }, ...over });
const deps = (cfg, extra = {}) => ({ agents, config: cfg, now: () => t0, sleep: async () => {}, ...extra });

beforeEach(() => {
  process.env.ROLE_ROUTER_STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'rr-state-'));
  cwd = mkdtempSync(path.join(os.tmpdir(), 'rr-repo-'));
  execFileSync('git', ['init', '-q'], { cwd });
});

test('usage limit pauses the account, writes a handoff, and falls through to the next profile', async () => {
  const cfg = config({ builder: { chain: ['a', 'b'], onTierDrop: 'auto' } }, [profile('a', 'A', 'limit', 'lite'), profile('b', 'B', 'ok', 'lite')]);
  const out = await dispatch(base({ role: 'builder', task: 'TASK-001', message: 'TASK-001' }), deps(cfg));
  assert.equal(out.status, 'ok');
  assert.equal(out.profile, 'b');
  assert.deepEqual(out.runs.map((r) => r.result.kind), ['usage_limit', 'ok']);
  const state = accountStates(cfg, t0).find((s) => s.account === 'A');
  assert.equal(state.pausedUntil.toISOString(), '2026-10-04T14:00:00.000Z');
  assert.ok(out.runs.every((r) => existsSync(r.recordPath)));
  assert.equal(existsSync(handoffPath(cwd, 'TASK-001')), false, 'handoff is archived once the task succeeds');
});

test('a paused account is skipped without launching its agent', async () => {
  const cfg = config({ builder: { chain: ['a', 'b'], onTierDrop: 'auto' } }, [profile('a', 'A', 'limit', 'lite'), profile('b', 'B', 'ok', 'lite')]);
  await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg));
  const second = await dispatch(base({ role: 'builder', task: 'TASK-002' }), deps(cfg));
  assert.deepEqual(second.runs.map((r) => r.profile), ['b']);
});

test('every profile limited → waiting with the earliest reset', async () => {
  const cfg = config({ builder: { chain: ['a', 'b'], onTierDrop: 'auto' } }, [profile('a', 'A', 'limit', 'lite'), profile('b', 'B', 'limit', 'lite')]);
  const out = await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg));
  assert.equal(out.status, 'waiting');
  assert.equal(out.resumeAt.toISOString(), '2026-10-04T14:00:00.000Z');
  assert.ok(existsSync(handoffPath(cwd, 'TASK-001')), 'handoff stays for the next run');
});

test('a crash is returned, not retried on another profile', async () => {
  const cfg = config({ builder: { chain: ['a', 'b'], onTierDrop: 'auto' } }, [profile('a', 'A', 'crash', 'lite'), profile('b', 'B', 'ok', 'lite')]);
  const out = await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg));
  assert.equal(out.status, 'crashed');
  assert.equal(out.runs.length, 1);
});

const architect = config(
  { architect: { chain: ['top', 'lite'], onTierDrop: 'ask' } },
  [profile('top', 'A', 'limit', 'top'), profile('lite', 'B', 'ok', 'lite')],
);

test('architect tier drop: headless returns needs_choice and runs nothing lighter', async () => {
  const out = await dispatch(base({ role: 'architect', message: 'feature' }), deps(architect));
  assert.equal(out.status, 'needs_choice');
  assert.deepEqual(out.runs.map((r) => r.profile), ['top']);
  assert.match(out.choice.question, /top-tier architect profiles are unavailable/);
});

test('architect tier drop: with the top account already paused, switch / wait / abort are honoured', async () => {
  const run = (answer) => dispatch(base({ role: 'architect', message: 'feature', mode: 'interactive' }), deps(architect, { ask: async () => answer }));
  await dispatch(base({ role: 'architect', message: 'feature' }), deps(architect)); // records the limit on account A
  const sw = await run('s');
  assert.equal(sw.profile, 'lite');
  assert.equal(sw.tierDropped, true);
  const wait = await run('w');
  assert.equal(wait.status, 'aborted');
  assert.equal(wait.resumeAt.toISOString(), '2026-10-04T14:00:00.000Z');
  assert.equal((await run('a')).status, 'aborted');
});

test('review avoids the Builder account, and asks before reviewing on it', async () => {
  const cfg = config(
    { builder: { chain: ['a'], onTierDrop: 'auto' }, worker: { chain: ['a', 'b'], onTierDrop: 'auto', avoidBuilderAccount: true } },
    [profile('a', 'A', 'ok', 'lite'), profile('b', 'B', 'ok', 'lite')],
  );
  await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg));
  const review = await dispatch(base({ role: 'review', task: 'TASK-001' }), deps(cfg));
  assert.equal(review.profile, 'b');

  const onlyA = { ...cfg, roles: { ...cfg.roles, worker: { chain: ['a'], onTierDrop: 'auto', avoidBuilderAccount: true } } };
  const headless = await dispatch(base({ role: 'review', task: 'TASK-001' }), deps(onlyA));
  assert.equal(headless.status, 'needs_choice');
  const yes = await dispatch(base({ role: 'review', task: 'TASK-001', mode: 'interactive' }), deps(onlyA, { ask: async () => 'y' }));
  assert.equal(yes.status, 'ok');
});

test('dry run describes the chain without launching or writing', async () => {
  const out = await dispatch(base({ role: 'architect', message: 'x', dryRun: true }), deps(architect));
  assert.deepEqual(out.plan.map((p) => p.profile), ['top', 'lite']);
  assert.equal(existsSync(path.join(cwd, '.role-router')), false);
});

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
const SESSION = `console.log('{"type":"thread.started","thread_id":"sess-1"}');`;
const SCRIPTS = {
  ok: `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));console.log('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}')`,
  limit: `${'{SESSION}'}console.log(JSON.stringify({type:'turn.failed',error:{message:"You've hit your usage limit. Try again in 2 hours."}}));process.exit(1)`,
  crash: `process.exit(2)`,
  unavailable: `console.log(JSON.stringify({type:'turn.failed',error:{message:'401 Unauthorized: no active subscription'}}));process.exit(1)`,
};
const launches = [];
const script = (model) => SCRIPTS[model].replace('{SESSION}', SESSION);
const fake = { ...codex, preflight: () => null, launch: (profile, account, prompt, opts) => {
  launches.push({ profile: profile.id, resume: opts.resume, prompt });
  return { command: process.execPath, args: ['-e', script(profile.model)] };
} };
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
const noSkills = () => ({ stacks: [], skills: [], missing: [], dropped: [] });
const deps = (cfg, extra = {}) => ({ agents, config: cfg, now: () => t0, sleep: async () => {}, skills: noSkills, ...extra });

beforeEach(() => {
  launches.length = 0;
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

const writePlan = () => writeFileSync(path.join(cwd, 'PLAN.md'), '## TASK-001 — T\n- status: building\n- depends:\n### Acceptance Criteria\n- [x] first thing\n- [ ] second thing\n');

test('handoff lists verified vs open criteria and live-state commands, not a snapshot', async () => {
  writePlan();
  const cfg = config({ builder: { chain: ['a'], onTierDrop: 'auto' } }, [profile('a', 'A', 'limit', 'lite')]);
  const out = await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg));
  const text = readFileSync(out.handoff, 'utf8');
  assert.match(text, /- \[x\] first thing/);
  assert.match(text, /- \[ \] second thing/);
  assert.match(text, /git -C .* status --short/);
  assert.match(text, /Run the task's verification gates/);
});

test('a crash also leaves a handoff', async () => {
  const cfg = config({ builder: { chain: ['a'], onTierDrop: 'auto' } }, [profile('a', 'A', 'crash', 'lite')]);
  const out = await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg));
  assert.equal(out.status, 'crashed');
  assert.ok(existsSync(out.handoff));
});

test('the same agent resumes its own session once its account resets', async () => {
  const cfg = config({ builder: { chain: ['a'], onTierDrop: 'auto' } }, [profile('a', 'A', 'limit', 'lite')]);
  const first = await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg));
  assert.equal(first.status, 'waiting');
  assert.equal(first.runs[0].result.sessionId, 'sess-1');

  const later = () => new Date('2026-10-04T15:00:00Z'); // past the 14:00 reset
  const flaky = { ...cfg, profiles: { a: { ...cfg.profiles.a, model: 'ok' } } };
  const second = await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(flaky, { now: later }));
  assert.equal(second.status, 'ok');
  assert.equal(second.runs[0].resumed, true);
  assert.equal(launches.at(-1).resume, 'sess-1');
  assert.match(launches.at(-1).prompt, /usage limit has reset/);
});

test('a failed resume falls back to a fresh start with the full prompt', async () => {
  const cfg = config({ builder: { chain: ['a'], onTierDrop: 'auto' } }, [profile('a', 'A', 'limit', 'lite')]);
  await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg));
  launches.length = 0;
  // Same profile id, but now the "agent" crashes when asked to resume and succeeds when fresh.
  const resumeBreaks = { ...fake, launch: (p, a, prompt, opts) => {
    launches.push({ resume: opts.resume });
    return { command: process.execPath, args: ['-e', script(opts.resume ? 'crash' : 'ok')] };
  } };
  const later = () => new Date('2026-10-04T15:00:00Z');
  const out = await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg, { now: later, agents: { codex: resumeBreaks, claude: resumeBreaks, opencode: resumeBreaks } }));
  assert.equal(out.status, 'ok');
  assert.deepEqual(launches.map((l) => Boolean(l.resume)), [true, false]);
});

test('every headless run record carries git evidence', async () => {
  const cfg = config({ builder: { chain: ['a'], onTierDrop: 'auto' } }, [profile('a', 'A', 'ok', 'lite')]);
  const out = await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg));
  const record = JSON.parse(readFileSync(out.runs[0].recordPath, 'utf8'));
  assert.equal(typeof record.evidence?.uncommittedFiles, 'number');
});

test('the skills block is resolved per profile agent and appended to the prompt', async () => {
  const cfg = config({ builder: { chain: ['a'], onTierDrop: 'auto' } }, [profile('a', 'A', 'ok', 'lite')]);
  const seen = [];
  const skills = ({ role, agent }) => { seen.push(`${role}/${agent}`); return { stacks: ['flutter'], skills: [{ name: 'tdd', why: 'core', path: '/x/tdd/SKILL.md' }], missing: ['pr'], dropped: [] }; };
  const out = await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg, { skills }));
  assert.deepEqual(seen, ['builder/codex']);
  assert.match(launches[0].prompt, /## Skills for this run[\s\S]*\/x\/tdd\/SKILL\.md/);
  assert.deepEqual(out.skills, { loaded: ['tdd'], missing: ['pr'], stacks: ['flutter'] });
});

test('raw chat runs get no skills block', async () => {
  const cfg = config({ builder: { chain: ['a'], onTierDrop: 'auto' } }, [profile('a', 'A', 'ok', 'lite')]);
  const skills = () => { throw new Error('should not resolve skills for raw prompts'); };
  await dispatch(base({ role: 'builder', task: 'TASK-001', raw: true, message: 'hello' }), deps(cfg, { skills }));
  assert.equal(launches[0].prompt, 'hello');
});

test('an unavailable account is paused and the chain moves on', async () => {
  const cfg = config({ builder: { chain: ['a', 'b'], onTierDrop: 'auto' } }, [profile('a', 'A', 'unavailable', 'lite'), profile('b', 'B', 'ok', 'lite')]);
  const out = await dispatch(base({ role: 'builder', task: 'TASK-001' }), deps(cfg));
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.runs.map((r) => r.result.kind), ['unavailable', 'ok']);
  assert.match(accountStates(cfg, t0).find((s) => s.account === 'A').reason, /account unavailable/);
});

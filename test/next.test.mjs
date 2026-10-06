import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBoard, setStatus } from '../lib/board.mjs';
import { runNext, verdictOf } from '../lib/next.mjs';

const PLAN = `## TASK-001 — A
- status: planned
- depends:
### Scope
x

## TASK-002 — B
- status: planned
- depends: TASK-001
`;
const repo = (plan = PLAN) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-next-'));
  writeFileSync(path.join(root, 'PLAN.md'), plan);
  return root;
};
// A scripted "dispatch": each role sets the status an agent would, then reports its outcome.
const scripted = (root, effects, outcomes = {}) => async ({ role, task }) => {
  const calls = (scripted.calls ??= []);
  calls.push(role);
  if (effects[role]) setStatus(root, task, effects[role]);
  return { status: outcomes[role] ?? 'ok', runs: [{ profile: `p-${role}` }], message: outcomes[role] };
};
const reset = () => { scripted.calls = []; };

test('happy path: build → review → docs, then stops at passed (merge is the human gate)', async () => {
  reset(); const root = repo();
  const r = await runNext({ root, dispatch: scripted(root, { builder: 'review', review: 'passed' }) });
  assert.equal(r.stop, 'passed');
  assert.equal(r.task, 'TASK-001');
  assert.deepEqual(scripted.calls, ['builder', 'review', 'docs']);
});

test('a dependent task is not picked until its dependency is done', async () => {
  reset(); const root = repo(PLAN.replace('status: planned\n- depends:\n', 'status: passed\n- depends:\n'));
  const r = await runNext({ root, dispatch: scripted(root, {}) });
  assert.equal(r.stop, 'drained');
  assert.deepEqual(scripted.calls, []);
});

test('review gaps_found stops the loop without running docs', async () => {
  reset(); const root = repo();
  const r = await runNext({ root, dispatch: scripted(root, { builder: 'review', review: 'gaps_found' }) });
  assert.equal(r.stop, 'gaps_found');
  assert.deepEqual(scripted.calls, ['builder', 'review']);
});

test('gaps_found is picked first and goes back through the builder', async () => {
  reset(); const root = repo(PLAN.replace('status: planned\n- depends:\n### Scope', 'status: gaps_found\n- depends:\n### Scope'));
  const r = await runNext({ root, dispatch: scripted(root, { builder: 'review', review: 'passed' }) });
  assert.equal(r.task, 'TASK-001');
  assert.equal(r.stop, 'passed');
});

test('a human_needed task blocks everything', async () => {
  reset(); const root = repo(PLAN.replace('status: planned\n- depends:\n### Scope', 'status: human_needed\n- depends:\n### Scope'));
  const r = await runNext({ root, dispatch: scripted(root, {}) });
  assert.equal(r.stop, 'human_needed');
  assert.deepEqual(scripted.calls, []);
});

test('a limited builder propagates waiting and does not review', async () => {
  reset(); const root = repo();
  const r = await runNext({ root, dispatch: scripted(root, {}, { builder: 'waiting' }) });
  assert.equal(r.stop, 'waiting');
  assert.deepEqual(scripted.calls, ['builder']);
});

test('a builder that escalates (leaves building) stops with the escalation command, not a vague stuck', async () => {
  reset(); const root = repo();
  const r = await runNext({ root, dispatch: scripted(root, { builder: 'building' }) });
  assert.equal(r.stop, 'needs_choice');
  assert.match(r.message, /role-router run escalation TASK-001/);
});

test('a stopped build with a handoff is resumed before new work', async () => {
  reset(); const root = repo(PLAN.replace('status: planned\n- depends:\n### Scope', 'status: building\n- depends:\n### Scope'));
  mkdirSync(path.join(root, '.role-router', 'runs', 'TASK-001'), { recursive: true });
  writeFileSync(path.join(root, '.role-router', 'runs', 'TASK-001', 'handoff.md'), 'x');
  const r = await runNext({ root, dispatch: scripted(root, { builder: 'review', review: 'passed' }) });
  assert.equal(r.task, 'TASK-001');
  assert.equal(r.stop, 'passed');
});

test('a builder that flags a sketch deviation (human_needed) stops the loop before review', async () => {
  reset(); const root = repo();
  const r = await runNext({ root, dispatch: scripted(root, { builder: 'human_needed' }) });
  assert.equal(r.stop, 'human_needed');
  assert.deepEqual(scripted.calls, ['builder']);
});

test('passing after more than one review round recommends /retro', async () => {
  reset(); const root = repo();
  const dir = path.join(root, '.role-router', 'runs', 'TASK-001');
  mkdirSync(dir, { recursive: true });
  for (const n of ['001', '002']) writeFileSync(path.join(dir, `${n}-p.json`), JSON.stringify({ role: 'worker', operation: 'review', result: { kind: 'ok' } }));
  const r = await runNext({ root, dispatch: scripted(root, { builder: 'review', review: 'passed' }) });
  assert.equal(r.stop, 'passed');
  assert.equal(r.retro, true);
  assert.match(r.message, /2 review rounds: run \/retro/);
});

test('a reviewer that prints its verdict but skips the board command still advances the task', async () => {
  reset(); const root = repo();
  const dispatch = async ({ role, task }) => {
    scripted.calls.push(role);
    if (role === 'builder') setStatus(root, task, 'review');
    const summary = role === 'review' ? '## Must-fix\n\nNone.\n\nAll criteria are met.\n\n**passed**' : 'done';
    return { status: 'ok', runs: [{ profile: 'p', result: { kind: 'ok', summary } }] };
  };
  const r = await runNext({ root, task: 'TASK-001', dispatch });
  assert.equal(r.stop, 'passed');
  assert.deepEqual(scripted.calls, ['builder', 'review', 'docs']);
});

test('verdict parsing takes the last verdict line and ignores prose mentions', () => {
  assert.equal(verdictOf('we considered gaps_found but\n\npassed'), 'passed');
  assert.equal(verdictOf('Status: gaps_found'), 'gaps_found');
  assert.equal(verdictOf('`human_needed`'), 'human_needed');
  assert.equal(verdictOf('the task passed review in my opinion'), null);
  assert.equal(verdictOf(undefined), null);
});

test('a task waiting on a human does not block an explicitly named task or independent work', async () => {
  reset();
  const root = repo(`## TASK-001 — A\n- status: human_needed\n- depends:\n\n## TASK-002 — B\n- status: planned\n- depends:\n`);
  const r = await runNext({ root, dispatch: scripted(root, { builder: 'review', review: 'passed' }) });
  assert.equal(r.task, 'TASK-002', 'auto-pick skips the waiting task');
  assert.equal(r.stop, 'passed');
});

test('A: a named task whose dependencies are not done is refused before any paid run', async () => {
  reset(); const root = repo();
  const r = await runNext({ root, task: 'TASK-002', dispatch: scripted(root, {}) });
  assert.equal(r.stop, 'stuck');
  assert.match(r.message, /depends on TASK-001/);
  assert.deepEqual(scripted.calls, []);
});

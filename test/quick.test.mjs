import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptance, createQuickTask, loadBoard, setStatus } from '../lib/board.mjs';
import { runNext } from '../lib/next.mjs';

function repo({ plan = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-quick-'));
  if (plan) writeFileSync(path.join(root, 'PLAN.md'), '## TASK-001 — A\n- status: done\n- depends:\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

test('quick tasks get sequential ids per kind, live outside git, and join the board', () => {
  const root = repo();
  const a = createQuickTask(root, 'fix', 'average([2,4]) returns 6 instead of 3');
  const b = createQuickTask(root, 'fix', 'second bug');
  const c = createQuickTask(root, 'quick', 'add a --json flag');
  assert.deepEqual([a.id, b.id, c.id], ['FIX-001', 'FIX-002', 'QUICK-001']);
  assert.equal(a.kind, 'fix');
  assert.ok(existsSync(path.join(root, '.role-router', 'tasks', 'FIX-001.md')));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).includes('.role-router'), false, '.role-router self-ignores');
  const board = loadBoard(root);
  assert.deepEqual(board.list.map((t) => t.id), ['TASK-001', 'FIX-001', 'FIX-002', 'QUICK-001']);
  setStatus(root, 'FIX-001', 'review');
  assert.equal(loadBoard(root).byId.get('FIX-001').status, 'review');
  assert.equal(acceptance(root, 'FIX-001').open.length, 3);
});

test('works in a repo with no PLAN.md at all', () => {
  const root = repo({ plan: false });
  assert.equal(loadBoard(root), null);
  createQuickTask(root, 'quick', 'tiny change');
  assert.deepEqual(loadBoard(root).list.map((t) => t.id), ['QUICK-001']);
});

test('a quick task runs through the same build → review → docs loop', async () => {
  const root = repo({ plan: false });
  const { id } = createQuickTask(root, 'fix', 'off by one in pagination');
  const calls = [];
  const dispatch = async ({ role, task }) => {
    calls.push(`${role}:${task}`);
    if (role === 'builder') setStatus(root, task, 'review');
    if (role === 'review') setStatus(root, task, 'passed');
    return { status: 'ok', runs: [{ profile: 'p' }] };
  };
  const r = await runNext({ root, task: id, dispatch });
  assert.equal(r.stop, 'passed');
  assert.deepEqual(calls, ['builder:FIX-001', 'review:FIX-001', 'docs:FIX-001']);
});

test('the size guard surfaces as human_needed and stops before review', async () => {
  const root = repo({ plan: false });
  const { id } = createQuickTask(root, 'quick', 'redesign the export pipeline');
  const r = await runNext({ root, task: id, dispatch: async ({ task }) => { setStatus(root, task, 'human_needed'); return { status: 'ok', runs: [] }; } });
  assert.equal(r.stop, 'human_needed');
});

test('empty descriptions and unknown kinds are rejected', () => {
  const root = repo();
  assert.throws(() => createQuickTask(root, 'fix', '  '), /describe the bug/);
  assert.throws(() => createQuickTask(root, 'nope', 'x'), /unknown quick task kind/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBoard, setStatus } from '../lib/board.mjs';

const PLAN = '## TASK-001 — A\n- status: planned\n- depends:\n### Scope\nx\n';
function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-board-'));
  writeFileSync(path.join(root, 'PLAN.md'), PLAN);
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-q', '-m', 'plan');
  return { root, g };
}

test('status changes never touch PLAN.md or dirty the working tree', () => {
  const { root } = repo();
  setStatus(root, 'TASK-001', 'building');
  assert.equal(readFileSync(path.join(root, 'PLAN.md'), 'utf8'), PLAN);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
  assert.equal(loadBoard(root).byId.get('TASK-001').status, 'building');
});

test('every worktree and branch sees the same live status', () => {
  const { root, g } = repo();
  const wt = path.join(root, '.role-router', 'worktrees', 'TASK-001');
  g('worktree', 'add', '-q', '-b', 'task/TASK-001', wt, 'main');
  setStatus(wt, 'TASK-001', 'review');           // a Builder working inside the worktree
  assert.equal(loadBoard(root).byId.get('TASK-001').status, 'review');
  g('checkout', '-q', '-b', 'other');
  assert.equal(loadBoard(root).byId.get('TASK-001').status, 'review');
});

test('PLAN.md status is only the starting value', () => {
  const { root } = repo();
  assert.equal(loadBoard(root).byId.get('TASK-001').status, 'planned');
  assert.throws(() => setStatus(root, 'TASK-001', 'nope'), /Unknown status/);
  assert.throws(() => setStatus(root, 'TASK-404', 'done'), /Unknown task/);
});

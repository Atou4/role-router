import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBoard, setStatus } from '../lib/board.mjs';
import { spawn } from 'node:child_process';

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

test('D: parallel writers on different tasks never erase each other', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-board-par-'));
  const ids = Array.from({ length: 12 }, (_, i) => `TASK-${String(i + 1).padStart(3, '0')}`);
  writeFileSync(path.join(root, 'PLAN.md'), ids.map((id) => `## ${id} — t\n- status: planned\n- depends:\n`).join('\n'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const board = new URL('../scripts/board.mjs', import.meta.url).pathname;
  // 12 separate processes, like 12 fanout builders finishing together.
  await Promise.all(ids.map((id) => new Promise((resolve) => spawn(process.execPath, [board, 'set-status', id, 'review'], { cwd: root }).on('close', resolve))));
  const statuses = loadBoard(root).list.map((t) => t.status);
  assert.deepEqual(statuses, ids.map(() => 'review'));
});

test('G: a parallel batch refuses unknown, unready, dependent and intra-batch-dependent tasks', async () => {
  const { batchProblems } = await import('../lib/board.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-batch-'));
  writeFileSync(path.join(root, 'PLAN.md'), [
    '## TASK-001 — a\n- status: done\n- depends:\n',
    '## TASK-002 — b\n- status: planned\n- depends: TASK-001\n',
    '## TASK-003 — c\n- status: planned\n- depends: TASK-002\n',
    '## TASK-004 — d\n- status: planned\n- depends: TASK-009\n',
    '## TASK-005 — e\n- status: review\n- depends:\n',
  ].join('\n'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const board = loadBoard(root);
  assert.deepEqual(batchProblems(board, ['TASK-002']).size, 0);
  const p = batchProblems(board, ['TASK-002', 'TASK-003', 'TASK-004', 'TASK-005', 'TASK-404']);
  assert.match(p.get('TASK-003'), /same batch/);
  assert.match(p.get('TASK-004'), /TASK-009, not done/);
  assert.match(p.get('TASK-005'), /status is review/);
  assert.equal(p.get('TASK-404'), 'unknown task');
  assert.ok(!p.has('TASK-002'));
});

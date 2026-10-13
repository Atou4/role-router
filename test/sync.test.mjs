import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isBuildable, loadBoard, setStatus } from '../lib/board.mjs';
import { syncRepo } from '../lib/sync.mjs';
import { ensureWorktree } from '../lib/worktree.mjs';

function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-sync-'));
  writeFileSync(path.join(root, 'PLAN.md'), '## TASK-001 — a\n- status: planned\n- depends:\n\n## TASK-002 — b\n- status: planned\n- depends: TASK-001\n\n## TASK-003 — c\n- status: planned\n- depends:\n');
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-q', '-m', 'plan');
  return { root, g };
}
const noGh = () => null;

test('a passed task whose branch was merged becomes done, its worktree is removed, and its dependent is unblocked', () => {
  const { root, g } = repo();
  const wt = ensureWorktree(root, 'TASK-001', 'main', { setup: false });
  writeFileSync(path.join(wt, 'feature.txt'), 'x');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'feature.txt'], { cwd: wt });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'feature'], { cwd: wt });
  setStatus(root, 'TASK-001', 'passed');
  g('merge', '-q', '--no-ff', 'task/TASK-001', '-m', 'merge');
  const r = syncRepo(root, { gh: noGh });
  assert.deepEqual(r.done, ['TASK-001']);
  assert.equal(existsSync(wt), false);
  const board = loadBoard(root);
  assert.equal(isBuildable(board.byId.get('TASK-002'), board), true);
});

test('without gh, an unmerged or merely-created branch is never treated as done', () => {
  const { root } = repo();
  ensureWorktree(root, 'TASK-003', 'main', { setup: false }); // fresh branch, no commits: "merged" by ancestry
  setStatus(root, 'TASK-003', 'review');
  assert.deepEqual(syncRepo(root, { gh: noGh }).done, []);
});

test('a merged PR reported by GitHub marks the task done whatever its local status', () => {
  const { root } = repo();
  setStatus(root, 'TASK-003', 'review');
  const r = syncRepo(root, { gh: () => new Set(['TASK-003']) });
  assert.deepEqual(r.done, ['TASK-003']);
  assert.equal(r.source, 'github');
});

import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { batchProblems, isBuildable, loadBoard, setStatus } from '../lib/board.mjs';
import { knownRepos, requireRepo } from '../lib/repos.mjs';
import { runNext } from '../lib/next.mjs';

const CLI = new URL('../role-router', import.meta.url).pathname;
function workspace() {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'rr-ws-'));
  const repo = (name, files) => {
    const root = path.join(ws, name);
    mkdirSync(root, { recursive: true });
    for (const [f, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), body); }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    return root;
  };
  const server = repo('Server', { 'PLAN.md': '## TASK-012 — Rehearse\n- status: planned\n- depends: TASK-011, Flutter:TASK-102, admin:TASK-030\n\n## TASK-011 — Infra\n- status: done\n- depends:\n' });
  const flutter = repo('Flutter', {
    'PLAN.md': '## TASK-102 — Migrate\n- status: planned\n- depends:\n',
    '.agent-board/tasks/TASK-102.md': '## TASK-102 — duplicate written by the Architect\n- status: done\n- depends:\n',
  });
  const admin = repo('admin', {
    '.agent-board/tasks/TASK-030.md': '## TASK-030 — Build admin\n- status: planned\n- depends:\nStatus: Backlog\nPriority: P0\n### Scope\nx\n',
    '.agent-board/tasks/TASK-001.md': '## Purpose\nAn older task in another format.\n',
  });
  return { ws, server, flutter, admin };
}

test('cross-repo dependencies are enforced until the other repo marks its task done', () => {
  const { server, flutter, admin } = workspace();
  const board = loadBoard(server);
  const t = board.byId.get('TASK-012');
  assert.equal(isBuildable(t, board), false);
  assert.match(batchProblems(board, ['TASK-012']).get('TASK-012'), /Flutter:TASK-102, admin:TASK-030, not done/);
  setStatus(flutter, 'TASK-102', 'done');
  setStatus(admin, 'TASK-030', 'done');
  assert.equal(isBuildable(loadBoard(server).byId.get('TASK-012'), loadBoard(server)), true);
});

test('a named task with an unfinished cross-repo dependency is refused before any run', async () => {
  const { server } = workspace();
  const r = await runNext({ root: server, task: 'TASK-012', dispatch: async () => { throw new Error('must not dispatch'); } });
  assert.equal(r.stop, 'stuck');
  assert.match(r.message, /Flutter:TASK-102/);
});

test('.agent-board tasks in the section format join the board; PLAN.md wins on duplicate ids; other files are ignored', () => {
  const { flutter, admin } = workspace();
  assert.deepEqual(loadBoard(admin).list.map((t) => [t.id, t.status]), [['TASK-030', 'planned']]);
  const f = loadBoard(flutter);
  assert.equal(f.list.length, 1);
  assert.equal(f.byId.get('TASK-102').status, 'planned', 'PLAN.md copy wins over the .agent-board duplicate');
});

test('outside a repo: a clear message, no raw git error; inside: the repo is remembered', () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'rr-nogit-'));
  assert.throws(() => requireRepo(outside, 'next'), /not inside a git repo[\s\S]*role-router -C <repo> next/);
  const { server } = workspace();
  requireRepo(server, 'next');
  assert.ok(knownRepos().some((r) => r.root === path.resolve(server) || r.root.endsWith(path.join(path.basename(path.dirname(server)), 'Server'))));
  const r = spawnSync(CLI, ['next'], { cwd: outside, encoding: 'utf8', env: process.env });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /fatal: not a git repository/);
  assert.match(r.stderr, /role-router -C <repo> next/);
});

test('-C runs any command as if started inside the repo', () => {
  const { server } = workspace();
  const r = spawnSync(CLI, ['-C', server, 'board', 'list'], { cwd: os.tmpdir(), encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /TASK-012/);
});

test('running inside a task worktree registers the main checkout, never the worktree', async () => {
  const { server } = workspace();
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: server });
  const wt = path.join(server, '.role-router', 'worktrees', 'TASK-012');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'task/TASK-012', wt], { cwd: server });
  requireRepo(wt, 'board');
  const roots = knownRepos().map((r) => r.root);
  assert.ok(roots.some((r) => r.endsWith(`${path.sep}Server`)));
  assert.ok(!roots.some((r) => r.includes('worktrees')));
});

import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseBranch, openPr, prBody } from '../lib/pr.mjs';
import { taskOfBranch } from '../lib/sync.mjs';
import { ensureWorktree } from '../lib/worktree.mjs';

const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-pr-'));
  writeFileSync(path.join(root, 'PLAN.md'), '## TASK-101 — Add adapter\n- status: passed\n- depends:\n');
  writeFileSync(path.join(root, 'CHANGELOG.md'), '# log\n');
  g(root, 'init', '-q', '-b', 'main'); g(root, 'add', '-A'); g(root, 'commit', '-q', '-m', 'init');
  g(root, 'checkout', '-q', '-b', 'dev'); writeFileSync(path.join(root, 'dev.txt'), 'x'); g(root, 'add', '-A'); g(root, 'commit', '-q', '-m', 'dev work');
  return root;
}
function docsRecord(root, id, summary) {
  const dir = path.join(root, '.role-router', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '003-p.json'), JSON.stringify({ operation: 'docs', role: 'worker', result: { kind: 'ok', summary } }));
}

test('the PR goes into the branch the task was cut from (recorded), with the docs PR body, committing leftovers first', () => {
  const root = repo(); // main checkout is on dev, the way the IncaCook app repo is worked
  const wt = ensureWorktree(root, 'TASK-101', 'HEAD', { setup: false });
  writeFileSync(path.join(wt, 'a.dart'), 'code'); g(wt, 'add', '-A'); g(wt, 'commit', '-q', '-m', 'TASK-101: adapter');
  writeFileSync(path.join(wt, 'CHANGELOG.md'), '# log\n- adapter\n'); // the docs step's uncommitted edit
  docsRecord(root, 'TASK-101', 'TASK-101 is passed.\n\n## PR body\n\n## Summary\nAdds the adapter.');
  const calls = [];
  const r = openPr(root, { id: 'TASK-101', title: 'Add adapter' }, { sh: (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stdout: cmd === 'gh' ? (args[1] === 'list' ? '[]' : 'https://github.com/o/r/pull/7\n') : '' }; } });
  assert.equal(r.base, 'dev');
  assert.equal(r.branch, 'task/TASK-101');
  assert.deepEqual(r.leftovers, ['CHANGELOG.md']);
  assert.equal(r.url, 'https://github.com/o/r/pull/7');
  assert.deepEqual(calls.map((c) => c.split(' ').slice(0, 3).join(' ')), ['gh pr list', 'git commit -am', 'git push -u', 'gh pr create']);
  assert.equal(readFileSync(r.bodyFile, 'utf8').trim(), '## Summary\nAdds the adapter.');
});

test('for an older task without a recorded base, the closest branch wins', () => {
  const root = repo();
  g(root, 'checkout', '-q', '-b', 'task/TASK-101-build');
  writeFileSync(path.join(root, 'b.txt'), 'y'); g(root, 'add', '-A'); g(root, 'commit', '-q', '-m', 'work');
  g(root, 'checkout', '-q', 'dev');
  assert.equal(baseBranch(root, 'TASK-101', 'task/TASK-101-build'), 'dev');
});

test('PR body falls back to the whole docs message; none without a docs run', () => {
  const root = repo();
  assert.equal(prBody(root, 'TASK-101'), null);
  docsRecord(root, 'TASK-101', 'Just a body');
  assert.equal(prBody(root, 'TASK-101'), 'Just a body');
});

test('branches task/<ID> and task/<ID>-something map to the task', () => {
  assert.equal(taskOfBranch('task/TASK-101'), 'TASK-101');
  assert.equal(taskOfBranch('task/TASK-101-build'), 'TASK-101');
  assert.equal(taskOfBranch('task/FIX-002'), 'FIX-002');
  assert.equal(taskOfBranch('feature/x'), null);
});

test('dry run with an exact open PR plans an update, without creating another PR', () => {
  const root = repo();
  g(root, 'branch', 'task/TASK-101');
  docsRecord(root, 'TASK-101', '## PR body\nUpdated.');
  const calls = [];
  const r = openPr(root, { id: 'TASK-101', title: 'Add adapter' }, { run: false, sh: (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: JSON.stringify([{ headRefName: 'task/TASK-101-extra', url: 'wrong' }, { headRefName: 'task/TASK-101', url: 'https://github.com/o/r/pull/7' }]) };
  } });
  assert.equal(r.url, 'https://github.com/o/r/pull/7');
  assert.equal(r.steps.some((step) => step.includes('create')), false);
  assert.ok(r.steps.some((step) => step.includes('edit')));
  assert.equal(calls.length, 1);
});

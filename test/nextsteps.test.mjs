import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRunnable, loadBoard } from '../lib/board.mjs';
import { ensureEscalation } from '../lib/escalations.mjs';
import { renderNext, suggestions } from '../lib/nextsteps.mjs';
import { registerRepo } from '../lib/repos.mjs';

const CLI = new URL('../role-router', import.meta.url).pathname;
function repo(name, plan, parent) {
  const root = path.join(parent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'PLAN.md'), plan);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  registerRepo(root);
  return root;
}
const task = (id, status, depends = '') => `## ${id} — t\n- status: ${status}\n- depends: ${depends}\n\n`;

function world() {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'rr-next-'));
  const server = repo('Server', task('TASK-002', 'passed') + task('TASK-003', 'planned', 'TASK-002') + task('TASK-004', 'planned', 'TASK-003') + task('TASK-009', 'planned'), parent);
  const admin = repo('Admin', task('TASK-030', 'gaps_found', 'Server:TASK-003') + task('TASK-031', 'human_needed'), parent);
  return { server, admin, repos: [{ root: server, name: 'Server' }, { root: admin, name: 'Admin' }] };
}

test('steps are ranked by what they unblock, across repos, with the exact command', () => {
  const { admin, repos } = world();
  ensureEscalation(admin, 'TASK-031', { type: 'product', question: 'Which flow?', detail: '1. A\n2. B' });
  const { steps, blocked } = suggestions(repos, { prs: () => null });
  // TASK-002 unblocks TASK-003, TASK-004 and (cross-repo) Admin:TASK-030.
  assert.equal(steps[0].kind, 'pr');
  assert.equal(steps[0].unblocks, 3);
  assert.deepEqual(steps[0].argv, ['pr', 'Server:TASK-002']);
  assert.equal(steps[0].act, true);
  const launch = steps.find((s) => s.kind === 'launch');
  assert.deepEqual(launch.argv, ['launch', 'Server:TASK-009', '--detach', '--yes']);
  const decide = steps.find((s) => s.kind === 'decide');
  assert.equal(decide.act, false, 'decisions are only proposed by the agent');
  assert.deepEqual(decide.argv, ['inbox'], 'no recommendation: show the options rather than pick one');
  assert.ok(blocked.some((b) => b.startsWith('Admin:TASK-030 waits on Server:TASK-003')), 'rework waiting on an unmerged dependency is explained, not launched');
});

test('rework only runs once its dependencies are done', () => {
  const { admin } = world();
  const board = loadBoard(admin);
  assert.equal(isRunnable(board.byId.get('TASK-030'), board), false);
});

test('the PR state picks the step: open → merge it yourself, merged → sync', () => {
  const { repos } = world();
  const open = suggestions(repos, { prs: () => new Map([['TASK-002', { state: 'OPEN', number: 7, url: 'https://x/7', checks: 'failing', review: null }]]) });
  assert.equal(open.steps[0].kind, 'merge');
  assert.match(open.steps[0].title, /PR #7 \(CI failing\)/);
  assert.deepEqual(open.steps[0].argv, []);
  const merged = suggestions(repos, { prs: () => new Map([['TASK-002', { state: 'MERGED' }]]) });
  assert.equal(merged.steps[0].kind, 'sync');
});

test('the panel collapses to one line while work runs and explains an empty board', () => {
  const { repos } = world();
  const next = suggestions(repos, { prs: () => null });
  const one = renderNext(next, { running: true });
  assert.equal(one.split('\n').length, 1);
  assert.match(one, /role-router do 1/);
  assert.match(renderNext(next), /role-router pr Server:TASK-002/);
  assert.match(renderNext({ steps: [], blocked: ['X waits on Y (planned)'] }), /X waits on Y/);
});

test('role-router do refuses an unknown step and a step that is yours alone', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'rr-do-'));
  const env = { ...process.env, ROLE_ROUTER_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), 'rr-do-state-')) };
  const root = path.join(parent, 'Solo');
  mkdirSync(root);
  writeFileSync(path.join(root, 'PLAN.md'), task('TASK-001', 'passed'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync(CLI, ['-C', root, 'status'], { env }); // registers the repo in that state dir
  const r = spawnSync(CLI, ['do', '3', '--yes'], { encoding: 'utf8', env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /there is no step 3; 1 step\(s\) right now/);
  assert.match(spawnSync(CLI, ['do'], { encoding: 'utf8', env }).stderr, /usage: role-router do/);
  const agent = spawnSync(CLI, ['do', '1', '--agent', '--yes'], { encoding: 'utf8', env });
  assert.match(agent.stderr, /Solo is in no project/);
});

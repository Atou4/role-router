import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pauseAccount } from '../lib/accounts.mjs';
import { buildBrief, createProject, findCodexSession, loadProject, sessionProfile, sessionRules, updateProject } from '../lib/projects.mjs';
import { scopeRepos } from '../lib/scope.mjs';
import { proposeConfig } from '../lib/setup.mjs';

const CLI = new URL('../role-router', import.meta.url).pathname;
const config = proposeConfig([
  { id: 'openai', agent: 'codex', topModel: 'gpt-6-sol', liteModel: 'gpt-6-luna' },
  { id: 'anthropic', agent: 'claude', topModel: 'opus', liteModel: 'sonnet' },
]);
const cfgFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'rr-pcfg-')), 'config.json');
writeFileSync(cfgFile, JSON.stringify(config));
process.env.ROLE_ROUTER_CONFIG = cfgFile;

function workspace() {
  const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rr-proj-')));
  const repo = (name, plan) => {
    const root = path.join(ws, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'PLAN.md'), plan);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    return root;
  };
  return {
    ws,
    server: repo('Server', '## TASK-001 — contracts\n- status: passed\n- depends:\n\n## TASK-012 — rehearse\n- status: planned\n- depends: TASK-001, App:TASK-102\n'),
    app: repo('App', '## TASK-101 — adapter\n- status: human_needed\n- depends:\n\n## TASK-102 — migrate\n- status: planned\n- depends: TASK-101\n'),
    other: repo('Other', '## TASK-900 — unrelated\n- status: planned\n- depends:\n'),
  };
}

test('a project groups repos by name or path; add and remove keep it tidy', () => {
  const { server, app, other } = workspace();
  const p = createProject('inca', ['Server', 'App'], { cwd: server });
  assert.deepEqual(p.repos, [server, app]);
  assert.throws(() => createProject('inca', ['Server'], { cwd: server }), /already exists/);
  assert.throws(() => createProject('bad name', ['Server'], { cwd: server }), /letters, digits/);
  updateProject('inca', { addRepos: [other], removeRepos: ['App'], cwd: server });
  assert.deepEqual(loadProject('inca').repos, [server, other]);
});

test('-P scopes multi-repo commands to the project', () => {
  const { server, other } = workspace();
  createProject('scoped', ['Server', 'App'], { cwd: server });
  spawnSync(CLI, ['board', 'list'], { cwd: other, env: process.env }); // Other is known, but not in the project
  process.env.ROLE_ROUTER_PROJECT = 'scoped';
  try { assert.deepEqual(scopeRepos().map((r) => r.name).sort(), ['App', 'Server']); } finally { delete process.env.ROLE_ROUTER_PROJECT; }
  const out = spawnSync(CLI, ['-P', 'scoped', 'status'], { cwd: os.tmpdir(), encoding: 'utf8', env: process.env }).stdout;
  assert.match(out, /Project scoped/);
  assert.match(out, /Server/);
  assert.doesNotMatch(out, /Other/);
});

test('the live brief is built from the files: boards with waits, inbox, decisions', () => {
  const { server, app } = workspace();
  const p = createProject('brief', ['Server', 'App'], { cwd: server });
  mkdirSync(path.join(app, '.role-router', 'escalations'), { recursive: true });
  writeFileSync(path.join(app, '.role-router', 'escalations', 'TASK-101.md'), '### Escalation\n- type: design\n- question: Which topic key?\n- options:\n  1. order id\n  2. delivery id\n');
  const brief = buildBrief(p);
  assert.match(brief, /TASK-012 planned: rehearse — waits on TASK-001, App:TASK-102/);
  assert.match(brief, /App:TASK-101 \[design\] Which topic key\?/);
  assert.match(brief, /blocks: TASK-102/);
  assert.match(sessionRules(p), /You do not write feature code here/);
  assert.match(sessionRules(p), /role-router -P brief status/);
});

test('session host: explicit choice, then the project setting, then the Architect chain skipping paused accounts', () => {
  const { server } = workspace();
  const p = createProject('host', ['Server'], { cwd: server });
  assert.equal(sessionProfile(p), 'openai-top');
  assert.equal(sessionProfile(p, 'anthropic-top'), 'anthropic-top');
  assert.equal(sessionProfile(updateProject('host', { profile: 'anthropic-lite' })), 'anthropic-lite');
  pauseAccount('openai', new Date(Date.now() + 3600_000), { reason: 'usage limit' });
  assert.equal(sessionProfile(updateProject('host', { profile: '' })), 'anthropic-top');
});

test('the Codex session started in the project folder is found by its session file', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-codex-sessions-'));
  const since = new Date('2026-10-13T15:00:00Z');
  const day = path.join(root, '2026', '10', String(since.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const meta = (id, cwd, ts) => JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: ts } }) + '\n';
  writeFileSync(path.join(day, 'a.jsonl'), meta('old', '/proj', '2026-10-13T14:00:00Z'));
  writeFileSync(path.join(day, 'b.jsonl'), meta('mine', '/proj', '2026-10-13T15:00:02Z'));
  writeFileSync(path.join(day, 'c.jsonl'), meta('elsewhere', '/other', '2026-10-13T15:00:03Z'));
  assert.equal(findCodexSession('/proj', since, root), 'mine');
});

test('open --print shows the host, a full-access interactive launch in the project folder, and the rules + brief', () => {
  const { server } = workspace();
  createProject('printme', ['Server', 'App'], { cwd: server });
  const r = spawnSync(CLI, ['project', 'open', 'printme', '--print', '--profile', 'openai-top'], { cwd: os.tmpdir(), encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout.slice(0, r.stdout.indexOf('\n--- message ---')));
  assert.equal(plan.launch.command, 'codex');
  assert.ok(plan.launch.args.includes('danger-full-access'));
  assert.match(r.stdout, /You are the Architect and orchestrator for the project "printme"/);
  assert.match(r.stdout, /live brief/);
});

test('a read-only session can look but every acting command is refused by the launcher', () => {
  const env = { ...process.env, ROLE_ROUTER_READONLY: '1' };
  for (const args of [['next'], ['launch', '--ready'], ['fix', 'x'], ['board', 'set-status', 'TASK-1', 'done'], ['sync'], ['pr', 'TASK-1'], ['resolve', 'TASK-1'], ['stop', '--all'], ['limits', 'pause', 'openai'], ['fan', 'q']]) {
    const r = spawnSync(CLI, args, { cwd: os.tmpdir(), encoding: 'utf8', env });
    assert.equal(r.status, 3, `${args.join(' ')} should be refused`);
    assert.match(r.stderr, /refused in a read-only session/);
  }
  for (const args of [['status'], ['inbox'], ['limits'], ['project', 'list'], ['watch', '--once']]) {
    const r = spawnSync(CLI, args, { cwd: os.tmpdir(), encoding: 'utf8', env });
    assert.notEqual(r.status, 3, `${args.join(' ')} should be allowed`);
  }
});

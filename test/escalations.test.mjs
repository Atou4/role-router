import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codex } from '../lib/agents/codex.mjs';
import { setStatus } from '../lib/board.mjs';
import { dispatch } from '../lib/dispatch.mjs';
import { backfill, blockedBy, decisionPrompt, ensureEscalation, escalationPath, isResolved, listEscalations, parseEscalation, recordDecision } from '../lib/escalations.mjs';
import { runNext } from '../lib/next.mjs';

const CLI = new URL('../role-router', import.meta.url).pathname;
function repo(name, plan, parent = mkdtempSync(path.join(os.tmpdir(), 'rr-esc-'))) {
  const root = path.join(parent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'PLAN.md'), plan);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}
const BLOCK = `Some prose first.

### Escalation
- **type:** design
- question: How does the adapter get the deliveryId?
- options:
  1. Order-keyed topic on the server
  2. Pass a deliveryId
- recommendation: 1, survives reassignment
- affects: Server:TASK-008, TASK-102
`;

test('the structured block parses, tolerating markdown, and an empty field never swallows the next line', () => {
  assert.deepEqual(parseEscalation(BLOCK), {
    type: 'design', question: 'How does the adapter get the deliveryId?',
    options: ['Order-keyed topic on the server', 'Pass a deliveryId'],
    recommendation: '1, survives reassignment', affects: ['Server:TASK-008', 'TASK-102'],
  });
  const e = parseEscalation('### Escalation\n- type: product\n- question: q?\n- options:\n- recommendation:\n- affects:\n');
  assert.equal(e.recommendation, undefined);
  assert.deepEqual(e.affects, []);
  assert.equal(parseEscalation('no block here'), null);
});

test('fallback escalations lift the options out of the agent prose; an agent-written one is kept', () => {
  const root = repo('App', '## TASK-101 — a\n- status: human_needed\n- depends:\n');
  ensureEscalation(root, 'TASK-101', { type: 'design', question: 'stopped', detail: 'What to decide, one of:\n1. Order topic\n2. Delivery id\n\nAlso unpinned: event names.' });
  assert.deepEqual(parseEscalation(readFileSync(escalationPath(root, 'TASK-101'), 'utf8')).options, ['Order topic', 'Delivery id']);
  writeFileSync(escalationPath(root, 'TASK-101'), BLOCK);
  assert.equal(ensureEscalation(root, 'TASK-101', { type: 'other', question: 'x' }), false);
});

test('backfill files one for a task already waiting on a human; blockedBy sees cross-repo dependents', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'rr-ws-'));
  const app = repo('App', '## TASK-101 — a\n- status: human_needed\n- depends:\n\n## TASK-102 — b\n- status: planned\n- depends: TASK-101\n', parent);
  const server = repo('Server', '## TASK-012 — c\n- status: planned\n- depends: App:TASK-101\n', parent);
  spawnSync(CLI, ['board', 'list'], { cwd: server, env: process.env }); // registers Server
  assert.equal(backfill([app]), 1);
  const [e] = listEscalations([app]);
  assert.equal(e.task, 'TASK-101');
  assert.deepEqual(blockedBy(app, 'TASK-101').sort(), ['Server:TASK-012', 'TASK-102']);
});

test('a decision is validated, closes the escalation, and is handed to every later prompt for the task', async () => {
  const root = repo('App', '## TASK-101 — a\n- status: human_needed\n- depends:\n');
  mkdirSync(path.dirname(escalationPath(root, 'TASK-101')), { recursive: true });
  writeFileSync(escalationPath(root, 'TASK-101'), BLOCK);
  assert.throws(() => recordDecision(root, 'TASK-101', { option: 3 }), /2 option/);
  assert.throws(() => recordDecision(root, 'TASK-101', {}), /--option <n> or --note/);
  recordDecision(root, 'TASK-101', { option: 1 });
  assert.ok(isResolved(root, 'TASK-101'));
  assert.deepEqual(listEscalations([root]), []);
  assert.match(decisionPrompt(root, 'TASK-101'), /option 1: Order-keyed topic on the server/);

  let seen = '';
  const fake = { ...codex, preflight: () => null, launch: (p, a, prompt) => { seen = prompt; return { command: process.execPath, args: ['-e', 'console.log(JSON.stringify({type:"turn.completed",usage:{}}))'] }; } };
  const config = { version: 2, accounts: { A: { agent: 'codex' } }, profiles: { a: { id: 'a', account: 'A', tier: 'lite' } }, roles: { builder: { chain: ['a'], onTierDrop: 'auto' } }, defaults: { cooldownMinutes: 60, transientRetries: 0, runTimeoutMinutes: 30 } };
  await dispatch({ role: 'builder', task: 'TASK-101', mode: 'headless', cwd: root }, { agents: { codex: fake, claude: fake, opencode: fake }, config, skills: () => ({ stacks: [], skills: [], references: [], missing: [], dropped: [] }) });
  assert.match(seen, /Decision from the human \(binding\)[\s\S]*Order-keyed topic/);
  assert.match(seen, /If you stop for a decision[\s\S]*escalations\/TASK-101\.md/);
});

test('the loop files an escalation when it stops for a human, and archives it when the task passes', async () => {
  const root = repo('App', '## TASK-001 — a\n- status: planned\n- depends:\n');
  const stopper = async ({ role, task }) => { if (role === 'builder') setStatus(root, task, 'human_needed'); return { status: 'ok', runs: [{ profile: 'p', result: { kind: 'ok', summary: 'Need a call:\n1. A\n2. B' } }] }; };
  const r = await runNext({ root, task: 'TASK-001', dispatch: stopper });
  assert.equal(r.stop, 'human_needed');
  const [e] = listEscalations([root]);
  assert.deepEqual(e.options, ['A', 'B']);

  setStatus(root, 'TASK-001', 'review');
  const passer = async ({ role, task }) => { if (role === 'review') setStatus(root, task, 'passed'); return { status: 'ok', runs: [{ profile: 'p', result: { kind: 'ok', summary: '' } }] }; };
  await runNext({ root, task: 'TASK-001', dispatch: passer });
  assert.equal(existsSync(escalationPath(root, 'TASK-001')), false);
  assert.ok(existsSync(`${escalationPath(root, 'TASK-001')}.done`));
});

test('resolve --no-run records the decision from the CLI', () => {
  const root = repo('App', '## TASK-101 — a\n- status: human_needed\n- depends:\n');
  mkdirSync(path.dirname(escalationPath(root, 'TASK-101')), { recursive: true });
  writeFileSync(escalationPath(root, 'TASK-101'), BLOCK);
  const r = spawnSync(CLI, ['resolve', 'TASK-101', '--option', '2', '--no-run'], { cwd: root, encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Decision recorded for App:TASK-101: Pass a deliveryId/);
  assert.ok(isResolved(root, 'TASK-101'));
});

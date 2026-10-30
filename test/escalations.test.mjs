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

// ISSUE-RR-005: seen live, IncaCook:TASK-104 was done and merged but its escalation stayed in the
// inbox, listed as blocking TASK-103 and TASK-105.
test('an escalation of a done task is not open: the inbox skips it and sync archives it', async () => {
  const root = repo('app', '## TASK-104 — a\n- status: human_needed\n- depends:\n\n## TASK-103 — b\n- status: planned\n- depends: TASK-104\n');
  ensureEscalation(root, 'TASK-104', { type: 'environment', question: 'Can the staging App ID be created?' });
  assert.equal(listEscalations([root]).length, 1);
  setStatus(root, 'TASK-104', 'done'); // done some other way than this sync (a merge seen earlier, by hand)
  assert.deepEqual(listEscalations([root]).map((e) => e.task), [], 'a done task blocks nothing');
  const { syncRepo } = await import('../lib/sync.mjs');
  syncRepo(root, { gh: () => new Set(), feedback: () => ({ rework: [], parked: [] }) });
  assert.equal(existsSync(escalationPath(root, 'TASK-104')), false, 'archived');
  assert.equal(existsSync(`${escalationPath(root, 'TASK-104')}.done`), true, 'kept as history');
});

// ISSUE-RR-007: seen live, TASK-103's Builder stopped human_needed with its blockers as bullets
// under "Not done"; the inbox entry was generic and had no options to resolve with.
test('a stop without a structured escalation still names the blockers and offers options', async () => {
  const root = repo('app', '## TASK-103 — a\n- status: planned\n- depends:\n');
  const said = 'I pinned the production ref, but TASK-103 is still not ready for review. I set its status to `human_needed`.\n\n**Gates**\n- `flutter test`: all 362 tests pass.\n\n**Not done**\n- **AC4:** no real `production.json` exists locally, so production validation has not run.\n- **AC5:** no staging build has been uploaded to testers.\n\nNext: provide production.json.';
  const dispatchFake = async ({ task }) => { setStatus(root, task, 'human_needed'); return { status: 'ok', runs: [{ profile: 'p', result: { summary: said } }] }; };
  const r = await runNext({ root, task: 'TASK-103', dispatch: dispatchFake, integrate: () => ({ status: 'skipped' }), policy: { notify: false } });
  assert.equal(r.stop, 'human_needed');
  const esc = parseEscalation(readFileSync(escalationPath(root, 'TASK-103'), 'utf8'));
  assert.match(esc.question, /AC4: no real production\.json[\s\S]*AC5: no staging build/);
  assert.ok(esc.options.length >= 2, `options: ${JSON.stringify(esc.options)}`);
  assert.equal(recordDecision(root, 'TASK-103', { option: 1 }).optionText, esc.options[0]);
});

test('an older stand-in with no options is rewritten from the agent\'s words when the inbox opens', () => {
  const root = repo('app', '## TASK-103 — a\n- status: human_needed\n- depends:\n');
  mkdirSync(path.dirname(escalationPath(root, 'TASK-103')), { recursive: true });
  writeFileSync(escalationPath(root, 'TASK-103'), "### Escalation\n- type: design\n- question: TASK-103 Builder stopped with human_needed; reasons are in the task's spec/Notes and its last run record\n- options:\n\n- recommendation:\n- affects:\n\n(Written by role-router from the stop; the agent did not raise a structured escalation.)\n\n#### Last words of the agent\nStill not ready.\n\n**Not done**\n- **AC5:** no staging build has been uploaded to testers.\n");
  backfill([root]);
  const esc = parseEscalation(readFileSync(escalationPath(root, 'TASK-103'), 'utf8'));
  assert.equal(esc.question, 'TASK-103 is blocked on: AC5: no staging build has been uploaded to testers');
  assert.equal(esc.options.length, 3);
  assert.match(readFileSync(escalationPath(root, 'TASK-103'), 'utf8'), /Last words of the agent\nStill not ready/);
});

// ISSUE-RR-001: seen live, resolve recorded the decision and logged it, then the Architect exited
// before applying it; the escalation vanished from the inbox and a retry would log it twice.
test('a decision the Architect could not apply stays in the inbox, and the retry reuses it', async () => {
  const { createProject } = await import('../lib/projects.mjs');
  const { decisionEntries } = await import('../lib/scope.mjs');
  const root = repo('App', '## TASK-101 — a\n- status: human_needed\n- depends:\n');
  mkdirSync(path.dirname(escalationPath(root, 'TASK-101')), { recursive: true });
  writeFileSync(escalationPath(root, 'TASK-101'), BLOCK);
  createProject('rr001', [root]);
  const cfg = path.join(root, '..', 'config.json');
  writeFileSync(cfg, JSON.stringify({ version: 2, accounts: { O: { agent: 'codex' } }, profiles: { 'o-top': { account: 'O', model: 'm', tier: 'top' } }, roles: { architect: { chain: ['o-top'], onTierDrop: 'auto' } } }));
  const env = { ...process.env, ROLE_ROUTER_CONFIG: cfg, PATH: path.dirname(process.execPath) + ':/usr/bin:/bin' }; // no codex on PATH
  const first = spawnSync(CLI, ['resolve', 'App:TASK-101', '--option', '1'], { cwd: root, encoding: 'utf8', env });
  assert.equal(first.status, 1);
  assert.match(first.stderr, /recorded but not applied/);
  assert.match(first.stderr, /role-router resolve App:TASK-101/);
  const pending = listEscalations([root]);
  assert.equal(pending.length, 1, 'still in the inbox');
  assert.match(pending[0].pending?.optionText ?? '', /Order-keyed topic/);
  const logged = decisionEntries('rr001').length;
  const retry = spawnSync(CLI, ['resolve', 'App:TASK-101'], { cwd: root, encoding: 'utf8', env });
  assert.match(retry.stdout, /Retrying the recorded decision for App:TASK-101: Order-keyed topic/);
  assert.equal(decisionEntries('rr001').length, logged, 'the retry does not log the decision again');
});

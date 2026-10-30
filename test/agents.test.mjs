import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codex } from '../lib/agents/codex.mjs';
import { dispatch, stderrHint } from '../lib/dispatch.mjs';

const noSkills = () => ({ stacks: [], skills: [], references: [], missing: [], dropped: [] });
const config = { version: 2, accounts: { A: { agent: 'codex' } }, profiles: { a: { id: 'a', account: 'A', tier: 'lite' } }, roles: { fan: { chain: ['a'], onTierDrop: 'auto' }, builder: { chain: ['a'], onTierDrop: 'auto' } }, defaults: { cooldownMinutes: 60, transientRetries: 0, runTimeoutMinutes: 30 } };

// ISSUE-RR-008: fan lanes run headless without full access, from any folder.
test('headless Codex runs skip the git-repo check, so they work outside a repo', () => {
  const profile = { id: 'a', model: 'm' };
  const fresh = codex.launch(profile, {}, 'hi', { mode: 'headless', cwd: '/tmp/x' });
  assert.ok(fresh.args.includes('--skip-git-repo-check'), fresh.args.join(' '));
  const resumed = codex.launch(profile, {}, 'hi', { mode: 'headless', cwd: '/tmp/x', resume: 'sess' });
  assert.ok(resumed.args.includes('--skip-git-repo-check'), resumed.args.join(' '));
  const interactive = codex.launch(profile, {}, 'hi', { mode: 'interactive', cwd: '/tmp/x' });
  assert.ok(!interactive.args.includes('--skip-git-repo-check'), 'interactive codex has no such flag');
});

test('a crashed agent reports the reason it printed on stderr, not just its exit code', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rr-crash-'));
  const fake = { ...codex, preflight: () => null, launch: () => ({ command: process.execPath, args: ['-e', "console.error('Reading additional input from stdin...'); console.error('Not inside a trusted directory and --skip-git-repo-check was not specified.'); process.exit(1)"] }) };
  const out = await dispatch({ role: 'fan', profile: 'a', raw: true, message: 'hi', mode: 'headless', cwd, task: 'fan-x' }, { agents: { codex: fake, claude: fake, opencode: fake }, config, skills: noSkills });
  const result = out.runs.at(-1).result;
  assert.equal(result.kind, 'crashed');
  assert.match(result.message, /codex exited 1 without completing a turn: Not inside a trusted directory/);
});

// ISSUE-RR-002: seen live, a headless Architect ran `board set-status TASK-017 done` on a task whose
// branch was never merged. Done means merged: only sync (after a merge) or a human sets it.
test('an agent cannot mark a task done; a human still can', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'rr-done-'));
  writeFileSync(path.join(root, 'PLAN.md'), '## TASK-017 — a\n- status: review\n- depends:\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const CLI = new URL('../role-router', import.meta.url).pathname;
  const asAgent = spawnSync(CLI, ['board', 'set-status', 'TASK-017', 'done'], { cwd: root, encoding: 'utf8', env: { ...process.env, ROLE_ROUTER_AGENT: 'architect' } });
  assert.equal(asAgent.status, 1);
  assert.match(asAgent.stderr, /done only after its PR is merged/);
  assert.equal(spawnSync(CLI, ['board', 'status', 'TASK-017'], { cwd: root, encoding: 'utf8' }).stdout.trim(), 'review');
  const env = { ...process.env }; delete env.ROLE_ROUTER_AGENT;
  assert.equal(spawnSync(CLI, ['board', 'set-status', 'TASK-017', 'done'], { cwd: root, encoding: 'utf8', env }).status, 0);
});

test('every agent process is marked with its role', async () => {
  const { readFileSync } = await import('node:fs');
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rr-env-'));
  const out = path.join(cwd, 'env.txt');
  const fake = { ...codex, preflight: () => null, launch: () => ({ command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.ROLE_ROUTER_AGENT ?? ''); console.log(JSON.stringify({type:'turn.completed',usage:{}}))`] }) };
  await dispatch({ role: 'fan', profile: 'a', raw: true, message: 'hi', mode: 'headless', cwd, task: 'fan-y' }, { agents: { codex: fake, claude: fake, opencode: fake }, config, skills: noSkills });
  assert.equal(readFileSync(out, 'utf8'), 'fan');
});

// ISSUE-RR-006: seen live, a Builder run from inside another agent's sandbox failed preflight with
// "Claude Code is not signed in" while the account was signed in: the sandbox hid the keychain.
test('a Claude sign-in the sandbox hides is reported as a sandbox problem, not as signed out', async () => {
  const { claude } = await import('../lib/agents/claude.mjs');
  const run = (keychain) => (cmd, args) => {
    if (cmd === 'claude' && args[0] === 'auth') return { status: 1, stdout: '{"loggedIn": false}' };
    if (cmd === 'security') return { status: keychain ? 0 : 206 };
    return { status: 0, stdout: '' };
  };
  const hidden = claude.preflight(undefined, undefined, { run: run(false), platform: 'darwin', installed: () => null });
  assert.match(hidden, /keychain[\s\S]*cannot reach[\s\S]*outside the sandbox/);
  assert.doesNotMatch(hidden, /run `claude auth login`/);
  const out = claude.preflight(undefined, undefined, { run: run(true), platform: 'darwin', installed: () => null });
  assert.match(out, /not signed in; run `claude auth login`/);
});

test('a crash that a sandbox caused says so', () => {
  assert.match(stderrHint('failed to initialize in-process app-server client: Operation not permitted'), /inside a sandbox/);
  assert.equal(stderrHint('Not inside a trusted directory'), '');
});

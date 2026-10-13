import './helpers/isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDeps, setupCommand } from '../lib/worktree.mjs';

const dir = (files) => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'rr-wt-'));
  for (const f of files) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), ''); }
  return d;
};
const noEnv = {};

test('the install command follows the lockfile and is skipped once dependencies exist', () => {
  assert.equal(setupCommand(dir(['pnpm-lock.yaml']), noEnv), 'pnpm install --frozen-lockfile --prefer-offline');
  assert.equal(setupCommand(dir(['pnpm-lock.yaml', 'node_modules/.modules.yaml']), noEnv), null);
  assert.equal(setupCommand(dir(['pnpm-lock.yaml', 'node_modules/.package-lock.json']), noEnv), 'pnpm install --frozen-lockfile --prefer-offline', 'an npm-made node_modules in a pnpm repo is reinstalled (the live case)');
  assert.equal(setupCommand(dir(['package-lock.json']), noEnv), 'npm ci --prefer-offline --no-audit --no-fund');
  assert.equal(setupCommand(dir(['pubspec.yaml']), noEnv), 'flutter pub get');
  assert.equal(setupCommand(dir(['pubspec.yaml', '.dart_tool/package_config.json']), noEnv), null);
  assert.equal(setupCommand(dir(['README.md']), noEnv), null);
});

test('an override replaces detection, and an empty one disables setup', () => {
  assert.equal(setupCommand(dir(['pnpm-lock.yaml']), { ROLE_ROUTER_WORKTREE_SETUP: 'make deps' }), 'make deps');
  assert.equal(setupCommand(dir(['pnpm-lock.yaml']), { ROLE_ROUTER_WORKTREE_SETUP: '' }), null);
});

test('a failed install is reported, never thrown', () => {
  const d = dir(['package-lock.json']);
  const r = ensureDeps(d, () => ({ status: 1, stdout: '', stderr: 'boom' }));
  assert.deepEqual(r, { ran: 'npm ci --prefer-offline --no-audit --no-fund', ok: false });
});

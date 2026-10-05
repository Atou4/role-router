import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const write = (obj) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'rr-cfg-')), 'config.json');
  writeFileSync(file, JSON.stringify(obj));
  return file;
};

test('v1 config upgrades to one profile and a one-entry chain per role', () => {
  const c = loadConfig(write({ version: 1, roles: {
    architect: { adapter: 'codex' },
    builder: { adapter: 'opencode', provider: 'zai-coding-plan', model: 'zai-coding-plan/glm-4.7', keyEnv: 'ZAI_API_KEY' },
  } }));
  assert.deepEqual(c.roles.architect, { chain: ['architect'], onTierDrop: 'ask' });
  assert.equal(c.profiles.architect.tier, 'top');
  assert.equal(c.profiles.builder.tier, 'lite');
  assert.equal(c.accounts['opencode-zai-coding-plan'].keyEnv, 'ZAI_API_KEY');
});

test('the shipped v2 example is valid', () => {
  const c = loadConfig(new URL('../config/role-router.v2.example.json', import.meta.url).pathname);
  assert.equal(c.roles.architect.chain[0], 'openai-top');
});

test('dangling references and unknown agents are rejected with a clear message', () => {
  assert.throws(() => loadConfig(write({ version: 2, accounts: { a: { agent: 'nope' } }, profiles: {}, roles: {} })), /unknown agent/);
  assert.throws(() => loadConfig(write({ version: 2, accounts: { a: { agent: 'codex' } }, profiles: {}, roles: { builder: { chain: ['x'] } } })), /unknown profile "x"/);
  assert.throws(() => loadConfig('/nonexistent/config.json'), /missing/);
});

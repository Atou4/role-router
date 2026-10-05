import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { detectAgents, proposeConfig } from '../lib/setup.mjs';

test('three accounts: planning on top tiers, execution on lite tiers in the chosen order, review avoids the builder', () => {
  const c = proposeConfig([
    { id: 'openai', agent: 'codex', topModel: 'gpt-6-sol', liteModel: 'gpt-6-luna' },
    { id: 'anthropic', agent: 'claude', topModel: 'opus', liteModel: 'sonnet' },
    { id: 'zai', agent: 'opencode', provider: 'zai-coding-plan', keyEnv: 'ZAI_API_KEY', liteModel: 'zai-coding-plan/glm-4.7' },
  ], { executionOrder: ['anthropic', 'openai', 'zai'] });
  assert.deepEqual(c.roles.architect.chain, ['openai-top', 'anthropic-top', 'anthropic-lite', 'openai-lite', 'zai-lite']);
  assert.deepEqual(c.roles.builder.chain, ['anthropic-lite', 'openai-lite', 'zai-lite', 'anthropic-top', 'openai-top']);
  assert.equal(c.roles.worker.avoidBuilderAccount, true);
  assert.deepEqual(c.roles.escalation.chain, ['openai-top', 'anthropic-top']);
  assert.equal(c.accounts.zai.keyEnv, 'ZAI_API_KEY');
  // round-trips through the real loader
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'rr-setup-')), 'config.json');
  writeFileSync(file, JSON.stringify(c));
  assert.equal(loadConfig(file).profiles['openai-top'].model, 'gpt-6-sol');
});

test('blank model means agent default for codex/claude, but OpenCode must name one', () => {
  const c = proposeConfig([{ id: 'openai', agent: 'codex', topModel: '', liteModel: '' }]);
  assert.equal(c.profiles['openai-top'].model, undefined);
  assert.throws(() => proposeConfig([{ id: 'x', agent: 'opencode', provider: 'x', liteModel: '' }]), /needs a provider\/model id/);
  assert.throws(() => proposeConfig([]), /at least one account/);
});

test('detection reads exit codes and model listings, never credentials', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'claude' && args[0] === 'auth') return { status: 0, stdout: '{ "loggedIn": true }' };
    if (cmd === 'opencode' && args[0] === 'models') return { status: 0, stdout: 'opencode/big-pickle\nzai-coding-plan/glm-4.7\n' };
    if (cmd === 'codex' && args[0] === 'login') return { status: 1, stdout: '' };
    return { status: 0, stdout: '1.0' };
  };
  const d = detectAgents(run);
  assert.deepEqual(d, { codex: { installed: true, signedIn: false }, claude: { installed: true, signedIn: true }, opencode: { installed: true, providers: ['opencode', 'zai-coding-plan'] } });
  assert.ok(calls.every((c) => !/auth\.json|token|key/i.test(c)));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { proposeConfig } from '../lib/setup.mjs';
import { pstackModelsRule } from '../lib/pstack.mjs';

const config = proposeConfig([
  { id: 'openai', agent: 'codex', topModel: 'gpt-6-sol', liteModel: 'gpt-6-luna' },
  { id: 'anthropic', agent: 'claude', topModel: 'opus', liteModel: 'sonnet' },
  { id: 'zai', agent: 'opencode', provider: 'zai', liteModel: 'zai/glm-4.7' },
], { executionOrder: ['anthropic', 'openai', 'zai'] });
const rule = pstackModelsRule(config);
const line = (role) => new RegExp(`^${role}: (.*)$`, 'm').exec(rule)?.[1];

test('panels get one profile per account; judges get the strongest, workers the preferred execution profile', () => {
  assert.equal(line('arena runners'), 'role-router:openai-top, role-router:anthropic-top, role-router:zai-lite');
  assert.equal(line('interrogate reviewers'), line('arena runners'));
  assert.equal(line('architect runners'), line('arena runners'));
  assert.equal(line('how explainer'), 'role-router:openai-top');
  assert.equal(line('how explorer'), 'role-router:anthropic-lite');
});

test('covers every role line setup-pstack writes, and tells the agent to use fan instead of Task slugs', () => {
  for (const role of ['feature, refactoring', 'bug-fix', 'perf-issue', 'hillclimb', 'judgment and prose', 'hardest tasks', 'how explorer', 'how explainer', 'why investigators', 'why synthesizer', 'reflect tooling', 'reflect judgment, divergent, synthesizer', 'arena runners', 'arena cross-judge pool', 'swarm workers', 'architect runners', 'interrogate reviewers']) {
    assert.ok(line(role), `missing ${role}`);
  }
  assert.match(rule, /^alwaysApply: true$/m);
  assert.match(rule, /role-router fan --profiles=/);
  assert.match(rule, /NOT Task model slugs/);
});

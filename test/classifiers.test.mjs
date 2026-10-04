import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codex } from '../lib/agents/codex.mjs';
import { parseResetFromText } from '../lib/agents/util.mjs';

const fixture = (p) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), 'utf8').trim().split('\n');
function classify(agent, lines, exit = 0, now = () => new Date('2026-10-04T12:00:00Z')) {
  const c = agent.classifier(now);
  for (const l of lines) c.onLine(l);
  return c.finish(exit);
}

test('codex: real successful run is ok and warnings do not count as failures', () => {
  const r = classify(codex, fixture('codex/ok.jsonl'));
  assert.equal(r.kind, 'ok');
  assert.equal(r.summary, 'OK');
  assert.ok(r.tokens > 0);
});

test('codex: usage limit on turn.failed carries a reset time', () => {
  const r = classify(codex, [
    '{"type":"turn.started"}',
    `{"type":"turn.failed","error":{"message":"You've hit your usage limit. Try again in 1 day 2 hours 30 minutes."}}`,
  ], 1);
  assert.equal(r.kind, 'usage_limit');
  assert.equal(r.resetAt.toISOString(), '2026-10-05T14:30:00.000Z');
});

test('codex: transient 429 retries, other failures crash', () => {
  assert.equal(classify(codex, ['{"type":"error","message":"429 Too Many Requests"}'], 1).kind, 'rate_limited');
  assert.equal(classify(codex, ['{"type":"error","message":"boom"}'], 1).kind, 'crashed');
  assert.equal(classify(codex, [], 1).kind, 'crashed');
});

test('reset text parsing', () => {
  const now = new Date('2026-10-04T12:00:00');
  assert.equal(parseResetFromText('limit reached · resets 5pm', now).getHours(), 17);
  assert.equal(parseResetFromText('nothing useful here', now), null);
});

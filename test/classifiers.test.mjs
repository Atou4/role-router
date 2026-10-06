import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codex } from '../lib/agents/codex.mjs';
import { claude } from '../lib/agents/claude.mjs';
import { opencode } from '../lib/agents/opencode.mjs';
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
  assert.equal(classify(codex, [], 0).kind, 'rate_limited');
});

test('reset text parsing', () => {
  const now = new Date('2026-10-04T12:00:00');
  assert.equal(parseResetFromText('limit reached · resets 5pm', now).getHours(), 17);
  assert.equal(parseResetFromText('nothing useful here', now), null);
});

test('claude: real successful run is ok with cost and turns; allowed rate_limit_event is ignored', () => {
  const r = classify(claude, fixture('claude/ok.jsonl'));
  assert.equal(r.kind, 'ok');
  assert.equal(r.summary, 'OK');
  assert.ok(r.costUsd > 0);
});

test('claude: a rejected rate_limit_event is a usage limit with the epoch reset', () => {
  const r = classify(claude, [
    '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1791144600,"rateLimitType":"five_hour"}}',
    '{"type":"result","is_error":true,"subtype":"success","result":"You\'ve hit your limit"}',
  ], 1);
  assert.equal(r.kind, 'usage_limit');
  assert.equal(r.resetAt.getTime(), 1791144600 * 1000);
});

test('claude: overageStatus rejected alone is not a plan limit', () => {
  const r = classify(claude, [
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","overageStatus":"rejected"}}',
    '{"type":"result","is_error":false,"result":"done","total_cost_usd":0.1,"num_turns":2,"usage":{"input_tokens":1,"output_tokens":1}}',
  ]);
  assert.equal(r.kind, 'ok');
});

test('opencode: 429 retries, quota text is a usage limit, clean exit is ok', () => {
  const err = (msg, status) => `{"type":"error","error":{"name":"APIError","data":{"message":"${msg}","statusCode":${status},"isRetryable":true}}}`;
  assert.equal(classify(opencode, [err('Rate limit exceeded', 429)], 1).kind, 'rate_limited');
  assert.equal(classify(opencode, [err('You have exceeded your plan quota. Try again in 3 hours', 429)], 1).kind, 'usage_limit');
  assert.equal(classify(opencode, ['{"type":"text","part":{"text":"hi"}}']).kind, 'ok');
});

test('account-level failures are "unavailable" on every agent, not crashes', () => {
  const oc = (msg, status) => `{"type":"error","error":{"name":"APIError","data":{"message":"${msg}","statusCode":${status}}}}`;
  assert.equal(classify(opencode, [oc('Upstream request failed: An active OpenCode Go subscription is required to use Go models.', 500)], 1).kind, 'unavailable');
  assert.equal(classify(opencode, [oc('nope', 401)], 1).kind, 'unavailable');
  assert.equal(classify(codex, ['{"type":"turn.failed","error":{"message":"401 Unauthorized"}}'], 1).kind, 'unavailable');
  assert.equal(classify(claude, ['{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}'], 1).kind, 'unavailable');
  assert.equal(classify(codex, ['{"type":"turn.failed","error":{"message":"segfault"}}'], 1).kind, 'crashed');
});

test('an agent that exits 0 without producing a result is transient (retried), a non-zero exit is a crash', () => {
  assert.equal(classify(claude, ['{"type":"system","subtype":"init","session_id":"s"}'], 0).kind, 'rate_limited');
  assert.equal(classify(claude, ['{"type":"system","subtype":"init","session_id":"s"}'], 1).kind, 'crashed');
  assert.equal(classify(codex, ['{"type":"thread.started","thread_id":"t"}'], 0).kind, 'rate_limited');
  assert.equal(classify(codex, ['{"type":"thread.started","thread_id":"t"}'], 1).kind, 'crashed');
});

test('E: a Claude run that finished successfully is ok even if a window was reported rejected', () => {
  const r = classify(claude, [
    '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1791144600,"rateLimitType":"seven_day_opus"}}',
    '{"type":"result","is_error":false,"result":"done","total_cost_usd":0.1,"num_turns":1,"usage":{"input_tokens":1,"output_tokens":1}}',
  ], 0);
  assert.equal(r.kind, 'ok');
});

test('F: a Codex turn that completed is ok even after a non-fatal error event', () => {
  const r = classify(codex, [
    '{"type":"error","message":"stream disconnected, retrying"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ], 0);
  assert.equal(r.kind, 'ok');
  assert.equal(classify(codex, ['{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}'], 1).kind, 'usage_limit');
});

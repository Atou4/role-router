// OpenCode agent. API-backed providers; credentials live in env (keyEnv) or `opencode auth`.
//
//   interactive: opencode <cwd> --model <provider/model> --prompt <prompt>
//   headless:    opencode run --dir <cwd> --model <provider/model> --format json <prompt>
//
// Headless events are JSONL with a `type`; failures look like
//   {"type":"error","error":{"name":"APIError","data":{"message":"…","statusCode":429,"isRetryable":true}}}
// A 429 is transient unless the message says the plan quota is gone. Provider wording varies,
// so quota detection is pattern-based (LIMIT_RE); add fixtures under test/fixtures/opencode/
// the first time a real provider limit is captured.

import { spawnSync } from 'node:child_process';
import { LIMIT_RE, TRANSIENT_RE, checkInstalled, parseResetFromText, tailOf } from './util.mjs';

const modelId = (profile, account) =>
  profile.model.includes('/') || !account.provider ? profile.model : `${account.provider}/${profile.model}`;

/** @type {import('./types.mjs').Agent} */
export const opencode = {
  executable: 'opencode',

  launch(profile, account, prompt, { mode, cwd, resume }) {
    const model = modelId(profile, account);
    const again = resume ? ['--session', resume] : [];
    return mode === 'headless'
      ? { command: 'opencode', args: ['run', '--dir', cwd, ...again, '--model', model, '--format', 'json', prompt] }
      : { command: 'opencode', args: [cwd, ...again, '--model', model, '--prompt', prompt] };
  },

  classifier(now = () => new Date()) {
    const messages = [];
    let failure = null;
    let sessionId;
    let cost = 0;
    let tokens = 0;
    return {
      onLine(line) {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.sessionID) sessionId = ev.sessionID;
        if (ev.type === 'text' && ev.part?.text) messages.push(ev.part.text);
        else if (ev.type === 'step_finish') { cost += ev.part?.cost ?? 0; tokens += (ev.part?.tokens?.input ?? 0) + (ev.part?.tokens?.output ?? 0); }
        else if (ev.type === 'error') {
          const data = ev.error?.data ?? {};
          failure = { message: data.message ?? ev.error?.name ?? 'error', status: data.statusCode, retryable: data.isRetryable };
        }
      },
      finish(exitCode) {
        const common = { tail: tailOf(messages), sessionId };
        if (failure) {
          const { message, status, retryable } = failure;
          if (status === 402 || LIMIT_RE.test(message)) {
            return { kind: 'usage_limit', message, resetAt: parseResetFromText(message, now()) ?? undefined, ...common };
          }
          if (status === 429 || retryable || TRANSIENT_RE.test(message)) return { kind: 'rate_limited', message, ...common };
          return { kind: 'crashed', message, ...common };
        }
        if (exitCode === 0) return { kind: 'ok', summary: messages.at(-1), ...common, tokens: tokens || undefined, costUsd: cost || undefined };
        return { kind: 'crashed', message: `opencode exited ${exitCode}`, ...common };
      },
    };
  },

  preflight(account, profile) {
    const missing = checkInstalled('opencode');
    if (missing) return missing;
    if (account.keyEnv && process.env[account.keyEnv]) return null;
    const provider = account.provider || profile.model.split('/')[0];
    const auth = spawnSync('opencode', ['auth', 'list'], { encoding: 'utf8' });
    if (auth.status === 0 && auth.stdout.toLowerCase().includes(provider.toLowerCase())) return null;
    return `${account.keyEnv ?? 'an API key'} is not set and OpenCode has no stored login for "${provider}"; run \`opencode auth login\``;
  },
};

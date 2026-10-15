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
import path from 'node:path';
import { LIMIT_RE, TRANSIENT_RE, UNAVAILABLE_RE, checkInstalled, parseResetFromText, tailOf } from './util.mjs';

const modelId = (profile, account) =>
  profile.model.includes('/') || !account.provider ? profile.model : `${account.provider}/${profile.model}`;

/**
 * Headless OpenCode refuses (silently, as a denied permission) to touch anything outside --dir. A
 * task worktree's board and escalations live in the main checkout's .role-router, and fan/pr-review
 * inputs live there too: allow those folders, on top of any OPENCODE_CONFIG_CONTENT already set.
 */
export function allowDirs(dirs, current = process.env.OPENCODE_CONFIG_CONTENT) {
  let config = {};
  try { config = current ? JSON.parse(current) : {}; } catch { /* not ours to fix */ }
  const permission = config.permission ?? {};
  const ext = typeof permission.external_directory === 'object' ? permission.external_directory : permission.external_directory ? { '*': permission.external_directory } : {};
  for (const d of dirs) ext[`${d}/**`] = 'allow';
  return JSON.stringify({ ...config, permission: { ...permission, external_directory: ext } });
}

/** @type {import('./types.mjs').Agent} */
export const opencode = {
  executable: 'opencode',

  launch(profile, account, prompt, { mode, cwd, resume, repoRoot, addDirs = [] }) {
    const model = modelId(profile, account);
    const again = resume ? ['--session', resume] : [];
    const env = { OPENCODE_CONFIG_CONTENT: allowDirs([...(repoRoot ? [path.join(repoRoot, '.role-router')] : []), ...addDirs]) };
    return mode === 'headless'
      ? { command: 'opencode', args: ['run', '--dir', cwd, ...again, '--model', model, '--format', 'json', prompt], env }
      : { command: 'opencode', args: [cwd, ...again, '--model', model, '--prompt', prompt], env };
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
          if (status === 401 || status === 403 || UNAVAILABLE_RE.test(message)) return { kind: 'unavailable', message, ...common };
          if (status === 429 || retryable || TRANSIENT_RE.test(message)) return { kind: 'rate_limited', message, ...common };
          return { kind: 'crashed', message, ...common };
        }
        // Seen live: a headless run denied a permission and exited 0 having said nothing.
        if (exitCode === 0 && !messages.length) return { kind: 'crashed', message: 'opencode ended without an answer (a denied permission?)', ...common };
        if (exitCode === 0) return { kind: 'ok', summary: messages.at(-1), ...common, tokens: tokens || undefined, costUsd: cost || undefined };
        return { kind: 'crashed', message: `opencode exited ${exitCode}`, ...common };
      },
    };
  },

  preflight(account, profile) {
    const missing = checkInstalled('opencode');
    if (missing) return missing;
    if (account.keyEnv && process.env[account.keyEnv]) return null;
    // `opencode auth list` prints display names ("OpenCode Go"), not provider ids, so ask OpenCode
    // directly whether it can reach any model for this provider.
    const provider = account.provider || profile.model.split('/')[0];
    const models = spawnSync('opencode', ['models', provider], { encoding: 'utf8', timeout: 30000 });
    if (models.status === 0 && models.stdout.split('\n').some((l) => l.trim().startsWith(`${provider}/`))) return null;
    return `${account.keyEnv ? `${account.keyEnv} is not set and ` : ''}OpenCode has no usable login for "${provider}"; run \`opencode auth login\``;
  },
};

// Claude Code agent. Uses the signed-in Claude Pro/Max plan; never an API key.
//
//   interactive: claude [--model M] <prompt>
//   headless:    claude -p <prompt> --output-format stream-json --verbose [--model M]
//                --dangerously-skip-permissions --add-dir <cwd>
//
// Headless events (claude 2.1): system/init, assistant, rate_limit_event, result.
//   rate_limit_event.rate_limit_info = { status: 'allowed' | 'allowed_warning' | 'rejected',
//                                        resetsAt: <epoch seconds>, rateLimitType: 'five_hour' | … }
//   result = { is_error, subtype, result: <text>, total_cost_usd, num_turns, usage }
// `overageStatus` inside rate_limit_info is about extra-usage billing, not the plan window.

import { spawnSync } from 'node:child_process';
import { LIMIT_RE, TRANSIENT_RE, UNAVAILABLE_RE, checkInstalled, parseResetFromText, tailOf } from './util.mjs';

/** @type {import('./types.mjs').Agent} */
export const claude = {
  executable: 'claude',

  launch(profile, account, prompt, { mode, cwd, resume }) {
    const model = profile.model ? ['--model', profile.model] : [];
    const again = resume ? ['--resume', resume] : [];
    if (mode === 'interactive') return { command: 'claude', args: [...again, ...model, prompt] };
    return {
      command: 'claude',
      args: ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...again, ...model, '--dangerously-skip-permissions', '--add-dir', cwd],
    };
  },

  classifier(now = () => new Date()) {
    const messages = [];
    let result = null;
    let blocked = null; // rate_limit_event with status 'rejected'
    let sessionId;
    return {
      onLine(line) {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.type === 'assistant') {
          for (const part of ev.message?.content ?? []) if (part.type === 'text') messages.push(part.text);
        } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'rejected') {
          const at = ev.rate_limit_info.resetsAt;
          blocked = { resetAt: at ? new Date(at * 1000) : undefined, type: ev.rate_limit_info.rateLimitType };
        } else if (ev.type === 'result') {
          result = ev;
        }
      },
      finish(exitCode) {
        const common = { tail: tailOf(messages), sessionId };
        const text = typeof result?.result === 'string' ? result.result : '';
        const usageFields = result && {
          costUsd: result.total_cost_usd,
          turns: result.num_turns,
          tokens: (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0),
        };
        if (blocked || (result?.is_error && LIMIT_RE.test(text))) {
          return {
            kind: 'usage_limit',
            message: text || `Claude plan limit (${blocked?.type ?? 'unknown window'})`,
            resetAt: blocked?.resetAt ?? parseResetFromText(text, now()) ?? undefined,
            ...common,
          };
        }
        if (result?.is_error && UNAVAILABLE_RE.test(text)) return { kind: 'unavailable', message: text, ...common };
        if (result?.is_error) return { kind: TRANSIENT_RE.test(text) ? 'rate_limited' : 'crashed', message: text, ...common };
        if (result && exitCode === 0) return { kind: 'ok', summary: text, ...common, ...usageFields };
        // Seen live: Claude Code occasionally exits 0 right after its init event. Retry rather than fail the run.
        if (exitCode === 0) return { kind: 'rate_limited', message: 'claude ended without a result (treated as transient)', ...common };
        return { kind: 'crashed', message: `claude exited ${exitCode} without a result`, ...common };
      },
    };
  },

  preflight() {
    const missing = checkInstalled('claude');
    if (missing) return missing;
    const auth = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' });
    if (auth.status !== 0) return 'Claude Code is not signed in; run `claude auth login`';
    return null;
  },
};

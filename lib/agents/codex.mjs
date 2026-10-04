// Codex CLI agent. Uses the signed-in ChatGPT plan; never an API key.
//
//   interactive: codex -C <cwd> [--model M] --sandbox workspace-write <prompt>
//   headless:    codex exec -C <cwd> [--model M] --sandbox workspace-write --json <prompt>
//
// Headless events (codex-cli 0.155): thread.started, turn.started, item.completed
// {item:{type:'agent_message'|'error'|…}}, turn.completed {usage}, turn.failed {error}.
// Note: `item.completed` with item.type 'error' is also used for harmless warnings
// (deprecations, skill budget), so only turn.failed / top-level error events count as failures.

import { spawnSync } from 'node:child_process';
import { LIMIT_RE, TRANSIENT_RE, checkInstalled, parseResetFromText, tailOf } from './util.mjs';

/** @type {import('./types.mjs').Agent} */
export const codex = {
  executable: 'codex',

  launch(profile, account, prompt, { mode, cwd, resume }) {
    const model = profile.model ? ['--model', profile.model] : [];
    if (resume) {
      // `resume` subcommands take no -C/--sandbox: the process cwd applies, the sandbox goes through -c.
      const sandbox = ['-c', 'sandbox_mode="workspace-write"'];
      return mode === 'headless'
        ? { command: 'codex', args: ['exec', 'resume', ...model, ...sandbox, '--json', resume, prompt] }
        : { command: 'codex', args: ['resume', ...model, ...sandbox, resume, prompt] };
    }
    const args = mode === 'headless' ? ['exec', '-C', cwd] : ['-C', cwd];
    args.push(...model, '--sandbox', 'workspace-write');
    if (mode === 'headless') args.push('--json');
    args.push(prompt);
    return { command: 'codex', args };
  },

  classifier(now = () => new Date()) {
    const messages = [];
    let usage;
    let completed = false;
    let failure = null;
    let sessionId;
    return {
      onLine(line) {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === 'thread.started') sessionId = ev.thread_id;
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') messages.push(ev.item.text ?? '');
        else if (ev.type === 'turn.completed') { completed = true; usage = ev.usage; }
        else if (ev.type === 'turn.failed') failure = ev.error?.message ?? 'turn failed';
        else if (ev.type === 'error') failure = ev.message ?? 'error';
      },
      finish(exitCode) {
        const tail = tailOf(messages);
        const common = { tail, sessionId };
        const tokens = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : undefined;
        if (failure) {
          if (LIMIT_RE.test(failure)) {
            return { kind: 'usage_limit', message: failure, resetAt: parseResetFromText(failure, now()) ?? undefined, ...common };
          }
          return { kind: TRANSIENT_RE.test(failure) ? 'rate_limited' : 'crashed', message: failure, ...common };
        }
        if (exitCode === 0 && completed) return { kind: 'ok', summary: messages.at(-1), tokens, ...common };
        return { kind: 'crashed', message: `codex exited ${exitCode} without completing a turn`, ...common };
      },
    };
  },

  preflight() {
    const missing = checkInstalled('codex');
    if (missing) return missing;
    const auth = spawnSync('codex', ['login', 'status'], { encoding: 'utf8' });
    return auth.status === 0 ? null : 'Codex CLI is not signed in; run `codex login`';
  },
};

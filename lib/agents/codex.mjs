// Codex CLI agent. Uses the signed-in ChatGPT plan; never an API key.
//
// Launch (from run-role.mjs today):
//   interactive: codex -C <cwd> [--model M] --sandbox workspace-write <prompt>
//   headless:    codex exec -C <cwd> [--model M] --sandbox workspace-write --json <prompt>
// Limit signal (codex exec --json): turn.failed / error item whose message reads like
//   "You've hit your usage limit. Try again in 4 days 20 hours 9 minutes."
//   → usage_limit, resetAt = now + parsed duration.
//
// Sketch for ADR-0006. Bodies are not implemented yet.

/** @type {import('./types.mjs').Agent} */
export const codex = {
  executable: 'codex',
  launch(profile, account, prompt, { mode, cwd }) {
    throw new Error('not implemented');
  },
  classifier() {
    throw new Error('not implemented');
  },
  preflight(account) {
    // `codex --version`, then `codex login status`
    throw new Error('not implemented');
  },
};

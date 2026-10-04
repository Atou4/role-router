// Claude Code agent. Uses the signed-in Claude Pro/Max plan; never an API key.
//
// Launch:
//   interactive: claude [--model M] <prompt>
//   headless:    claude -p <prompt> --output-format stream-json --verbose [--model M]
//                + the role's Permission Policy (today: --dangerously-skip-permissions)
// Limit signals (stream-json):
//   {"type":"rate_limit_event", ...reset fields...}  informational, keep the reset time
//   final {"type":"result","is_error":true,...} with "limit reached … resets <time>"
//   → usage_limit, resetAt from the event or the "resets" text.
//
// Sketch for ADR-0006. Bodies are not implemented yet.

/** @type {import('./types.mjs').Agent} */
export const claude = {
  executable: 'claude',
  launch(profile, account, prompt, { mode, cwd }) {
    throw new Error('not implemented');
  },
  classifier() {
    throw new Error('not implemented');
  },
  preflight(account) {
    throw new Error('not implemented');
  },
};

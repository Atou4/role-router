// OpenCode agent. API-backed providers; credentials live in env (keyEnv) or `opencode auth`.
//
// Launch:
//   interactive: opencode <cwd> --model <provider/model> --prompt <prompt>
//   headless:    opencode run --dir <cwd> --model <provider/model> --format json <prompt>
// Limit signal (--format json):
//   {"type":"error","error":{"name":"APIError","data":{"statusCode":429,"isRetryable":true,...}}}
//   → rate_limited when retryable without a long reset; usage_limit when the provider
//     says the plan quota is exhausted (exact wording per provider: capture fixtures).
//
// Sketch for ADR-0006. Bodies are not implemented yet.

/** @type {import('./types.mjs').Agent} */
export const opencode = {
  executable: 'opencode',
  launch(profile, account, prompt, { mode, cwd }) {
    throw new Error('not implemented');
  },
  classifier() {
    throw new Error('not implemented');
  },
  preflight(account) {
    // keyEnv set, or `opencode auth list` mentions account.provider
    throw new Error('not implemented');
  },
};

// Role Router — the private contract every agent module implements.
//
// One module per CLI owns everything specific to it: launch flags, model flag
// spelling, headless event format, and limit-message parsing. Dispatch only
// sees AgentResult. An ACP-backed agent would be one more module here.

/**
 * @typedef {object} AgentResult
 * @property {'ok' | 'usage_limit' | 'unavailable' | 'rate_limited' | 'crashed'} kind
 *   usage_limit  plan/window exhausted → pause the account, fall through
 *   unavailable  the account cannot be used (no active plan, bad credentials) → pause it, fall through
 *   rate_limited transient (e.g. 429 with short or no reset) → retry same profile
 * @property {Date} [resetAt]    parsed from the agent's message when present
 * @property {string} [message]  the agent's own error text
 * @property {string} [summary]  final assistant message, when the agent reports one
 * @property {string} [tail]     last assistant messages, for handoff files
 * @property {number} [tokens]   input+output tokens when the agent reports them
 * @property {number} [costUsd]  when the agent reports it
 * @property {number} [turns]    when the agent reports it
 * @property {string} [sessionId] the agent's own session id, for resuming after a limit
 */

/**
 * @typedef {object} Launch
 * @property {string} command
 * @property {string[]} args
 */

/**
 * @typedef {object} Classifier
 * @property {(line: string) => void} onLine            fed every stdout line of a headless run
 * @property {(exitCode: number | null) => AgentResult} finish
 */

/**
 * @typedef {object} Agent
 * @property {string} executable
 * @property {(profile: import('../config.mjs').Profile, account: import('../config.mjs').Account,
 *             prompt: string, opts: { mode: 'interactive' | 'headless', cwd: string, resume?: string }) => Launch} launch
 * @property {(now?: () => Date) => Classifier} classifier
 * @property {(account: import('../config.mjs').Account, profile: import('../config.mjs').Profile) => string | null} preflight
 *   returns a user-facing problem (not installed / not signed in) or null
 */

export {};

// Role Router — config loading (v2: accounts → profiles → role chains).
//
// Sketch for ADR-0006. Bodies are not implemented yet.

/** @typedef {'codex' | 'claude' | 'opencode'} AgentName */
/** @typedef {'top' | 'lite'} Tier */

/**
 * A paid plan or API credential. Usage limits are tracked per account.
 * @typedef {object} Account
 * @property {AgentName} agent
 * @property {string} [provider]  OpenCode provider id (e.g. "zai-coding-plan")
 * @property {string} [keyEnv]    env var OpenCode reads; never read by Role Router itself
 */

/**
 * An account + model pairing that a Role can run on.
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} account     key into Config.accounts
 * @property {string} [model]     agent-native model id, passed through untouched (never validated here); omitted = agent default
 * @property {Tier} tier
 */

/**
 * @typedef {object} RolePolicy
 * @property {string[]} chain                 profile ids, most preferred first
 * @property {'ask' | 'auto'} onTierDrop      ask = consent before using a lower tier than chain[0]
 * @property {boolean} [avoidBuilderAccount]  worker only: prefer a different account than the task's Builder
 * @property {'ask' | 'auto'} [onSameAccountReview]  worker only: when only the Builder's account is usable (default 'ask')
 */

/**
 * @typedef {object} Config
 * @property {2} version
 * @property {Record<string, Account>} accounts
 * @property {Record<string, Profile>} profiles
 * @property {Record<'architect' | 'builder' | 'worker' | 'escalation', RolePolicy>} roles
 * @property {{ cooldownMinutes: number, transientRetries: number }} defaults
 */

/**
 * Load, upgrade (v1 → v2), and validate the user config.
 * v1 `roles.<role> = { adapter, provider?, model?, keyEnv? }` becomes one account,
 * one profile (tier top for architect, lite otherwise) and a one-entry chain.
 * Throws with a user-facing message on unknown agents, dangling profile ids, or empty chains.
 * @param {string} [configPath] defaults to $ROLE_ROUTER_CONFIG or ~/.role-router/config.json
 * @returns {Config}
 */
export function loadConfig(configPath) {
  throw new Error('not implemented');
}

// Role Router — user-wide usage-limit ledger (~/.role-router/state/accounts.json).
//
// Limits apply across every repo, so this lives beside the user config, not in
// the repository. Parallel fan-out lanes may write concurrently: writes re-read
// the file and merge, and a pause only ever extends (max of pausedUntil).
//
// Sketch for ADR-0006. Bodies are not implemented yet.

/**
 * @typedef {object} AccountState
 * @property {string} account
 * @property {Date | null} pausedUntil   null = available
 * @property {string} [reason]           e.g. "usage limit"
 * @property {string} [seenOn]           task id or "interactive"
 */

/**
 * Current state for every account in the config; expired pauses read as available.
 * @param {import('./config.mjs').Config} config
 * @param {Date} [now]
 * @returns {AccountState[]}
 */
export function accountStates(config, now = new Date()) {
  throw new Error('not implemented');
}

/**
 * Mark an account exhausted until `until`. Never shortens an existing pause.
 * @param {string} account
 * @param {Date} until
 * @param {{ reason: string, seenOn?: string }} detail
 */
export function pauseAccount(account, until, detail) {
  throw new Error('not implemented');
}

/** @param {string} account */
export function clearAccount(account) {
  throw new Error('not implemented');
}

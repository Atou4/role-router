// Role Router — per-repo run records and handoff files (private to dispatch).
//
//   .role-router/runs/<task>/<seq>-<profile>.jsonl   raw agent events
//   .role-router/runs/<task>/<seq>-<profile>.json    RunRecord
//   .role-router/runs/<task>/handoff.md              latest handoff, read by the next profile
//
// Ad-hoc runs without a task use the id `adhoc-<yyyymmdd-hhmmss>`.
//
// Sketch for ADR-0006. Bodies are not implemented yet.

/**
 * @typedef {object} RunRecord
 * @property {string} task
 * @property {string} role
 * @property {string} profile
 * @property {string} account
 * @property {string} startedAt
 * @property {string} endedAt
 * @property {import('./agents/types.mjs').AgentResult} result
 * @property {boolean} tierDropped
 */

/**
 * Open the next numbered event log + record pair for a task.
 * @returns {{ eventsPath: string, finish(record: Omit<RunRecord, 'task'>): string }}
 */
export function startRun(repoRoot, task, profileId) {
  throw new Error('not implemented');
}

/** Account of the most recent run of `role` on `task` that ended ok, if any. */
export function lastAccountFor(repoRoot, task, role) {
  throw new Error('not implemented');
}

/**
 * Write handoff.md without a model call: goal (task spec reference), `git diff --stat`
 * in cwd, the last assistant messages from the dying run's events, and the limit reason.
 * @returns {string} path to handoff.md
 */
export function writeHandoff(repoRoot, task, cwd, eventsPath, reason) {
  throw new Error('not implemented');
}

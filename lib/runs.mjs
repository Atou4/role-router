// Role Router — per-repo run records and handoff files (private to dispatch).
//
//   <repo>/.role-router/runs/<task>/<seq>-<profile>.jsonl   raw agent events (headless)
//   <repo>/.role-router/runs/<task>/<seq>-<profile>.json    RunRecord
//   <repo>/.role-router/runs/<task>/handoff.md              latest handoff, read by the next profile
//
// <repo> is the main checkout even when the agent works in a worktree, so the history
// of a task stays in one place. Ad-hoc runs without a task use `adhoc-<yyyymmdd-hhmmss>`.

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acceptance } from './board.mjs';

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
 * @property {{ commit?: string, uncommittedFiles: number, diffStat?: string }} [evidence]  git state when the run ended
 */

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The main checkout for `cwd`, resolving worktrees back to their primary repo; `cwd` outside git. */
export function repoRootFor(cwd) {
  try {
    const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    return path.basename(common) === '.git' ? path.dirname(common) : git(cwd, 'rev-parse', '--show-toplevel');
  } catch {
    return cwd;
  }
}

const runDir = (repoRoot, task) => path.join(repoRoot, '.role-router', 'runs', task);
export const handoffPath = (repoRoot, task) => path.join(runDir(repoRoot, task), 'handoff.md');
export const hasHandoff = (repoRoot, task) => existsSync(handoffPath(repoRoot, task));

/**
 * Open the next numbered event log + record pair for a task.
 * @returns {{ events: import('node:fs').WriteStream, recordPath: string, finish(record: Omit<RunRecord, 'task'>): string }}
 */
export function startRun(repoRoot, task, profileId) {
  const dir = runDir(repoRoot, task);
  mkdirSync(dir, { recursive: true });
  const seq = String(readdirSync(dir).filter((f) => /^\d+-.*\.json$/.test(f)).length + 1).padStart(3, '0');
  const stem = path.join(dir, `${seq}-${profileId}`);
  const events = createWriteStream(`${stem}.jsonl`);
  return {
    events,
    recordPath: `${stem}.json`,
    finish(record) {
      events.end();
      writeFileSync(`${stem}.json`, JSON.stringify({ task, ...record }, null, 2) + '\n');
      return `${stem}.json`;
    },
  };
}

/** Every task with run records, each with its runs oldest-first (for `role-router status`). */
export function listRuns(repoRoot) {
  const root = path.join(repoRoot, '.role-router', 'runs');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    const dir = path.join(root, d.name);
    const runs = readdirSync(dir).filter((f) => /^\d+-.*\.json$/.test(f)).sort().flatMap((f) => {
      try {
        const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
        return [{ profile: r.profile, role: r.role, kind: r.result?.kind, endedAt: r.endedAt, evidence: r.evidence, tokens: r.result?.tokens, costUsd: r.result?.costUsd }];
      } catch { return []; }
    });
    return { task: d.name, runs, handoff: hasHandoff(repoRoot, d.name) };
  }).filter((t) => t.runs.length > 0 || t.handoff);
}

/** Account of the most recent run of `role` on `task` that ended ok, if any. */
export function lastAccountFor(repoRoot, task, role) {
  const dir = runDir(repoRoot, task);
  if (!existsSync(dir)) return null;
  const records = readdirSync(dir).filter((f) => /^\d+-.*\.json$/.test(f)).sort().reverse();
  for (const file of records) {
    try {
      const r = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      if (r.role === role && r.result?.kind === 'ok') return r.account;
    } catch { /* skip unreadable record */ }
  }
  return null;
}

/**
 * Checkpoint evidence for a run record: where the work stands in git right now.
 * Facts the orchestrator observed itself, never the agent's claims.
 */
export function gitEvidence(cwd) {
  const tryGit = (...args) => { try { return git(cwd, ...args); } catch { return undefined; } };
  const status = tryGit('status', '--short');
  if (status === undefined) return undefined; // not a git directory
  return {
    commit: tryGit('rev-parse', '--short', 'HEAD'), // undefined before the first commit
    uncommittedFiles: status.split('\n').filter(Boolean).length,
    diffStat: tryGit('diff', '--shortstat', 'HEAD') || undefined,
  };
}

/**
 * Session id of the newest run of `profileId` on `task` if it was interrupted by a limit,
 * so the same agent can resume its own conversation once its account resets.
 */
export function resumableSession(repoRoot, task, profileId) {
  const dir = runDir(repoRoot, task);
  if (!existsSync(dir)) return null;
  const records = readdirSync(dir).filter((f) => /^\d+-.*\.json$/.test(f)).sort().reverse();
  for (const file of records) {
    try {
      const r = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      if (r.profile !== profileId) continue;
      return ['usage_limit', 'rate_limited'].includes(r.result?.kind) ? (r.result.sessionId ?? null) : null;
    } catch { /* skip unreadable record */ }
  }
  return null;
}

/**
 * Write handoff.md without a model call. Live facts are commands to re-run (a pasted
 * snapshot would be stale by the time it is read); the task's acceptance criteria give
 * the verified / not-yet-done split.
 * @returns {string} path to handoff.md
 */
export function writeHandoff(repoRoot, task, { cwd, reason, profile, tail }) {
  const criteria = acceptance(repoRoot, task);
  const tick = (items, mark) => items.map((i) => `- [${mark}] ${i}`).join('\n') || '- (none)';
  const body = `# Handoff: ${task}

Previous agent: \`${profile}\` stopped because: ${reason}

## Where things are
- Task spec: the \`${task}\` section of \`${path.join(repoRoot, 'PLAN.md')}\` (or the board task). It is the source of truth.
- Working directory: \`${cwd}\`
- Re-read the live state instead of trusting this file:
  \`\`\`
  git -C ${cwd} status --short
  git -C ${cwd} diff --stat HEAD
  git -C ${cwd} log --oneline -5
  \`\`\`

## Acceptance criteria
${criteria ? `Verified (ticked by the previous agent):\n${tick(criteria.done, 'x')}\n\nStill open:\n${tick(criteria.open, ' ')}` : '(task has no parseable acceptance criteria — read the spec)'}

## Last words of the previous agent
${tail?.trim() || '(none captured)'}

## Before new work
Run the task's verification gates once to confirm the current state, then continue.

## Do not
- Redo criteria that are already verified.
- Edit or delete tests to make them pass.
- Change the task status except as the status contract describes.
`;
  const file = handoffPath(repoRoot, task);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

/** Called after a successful run so a stale handoff is not replayed. */
export function archiveHandoff(repoRoot, task) {
  if (hasHandoff(repoRoot, task)) renameSync(handoffPath(repoRoot, task), path.join(runDir(repoRoot, task), 'handoff.done.md'));
}

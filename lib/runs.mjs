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
 * Write handoff.md without a model call: where to find the task, why the last agent
 * stopped, what changed in the worktree, and what the agent last said.
 * @returns {string} path to handoff.md
 */
export function writeHandoff(repoRoot, task, { cwd, reason, profile, tail }) {
  let changes = '(could not read git state)';
  try {
    const stat = git(cwd, 'diff', '--stat', 'HEAD');
    const status = git(cwd, 'status', '--short');
    changes = [stat && `\`\`\`\n${stat}\n\`\`\``, status && `Uncommitted:\n\`\`\`\n${status}\n\`\`\``].filter(Boolean).join('\n\n') || 'No changes yet.';
  } catch { /* not a git dir */ }
  const body = `# Handoff: ${task}

Previous agent: \`${profile}\` stopped because: ${reason}

## Task
Read the task spec for \`${task}\` (PLAN.md section or board task) — it is the source of truth.
Work is in: \`${cwd}\`

## What changed so far
${changes}

## Last words of the previous agent
${tail?.trim() || '(none captured)'}

## Instructions
Continue from the current state of the working directory. Do not redo finished work. Keep the task status contract.
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

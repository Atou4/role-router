// Role Router — reconcile merged work: a merged task/<ID> branch marks the task done.
//
// Merged PRs are read through `gh` when the repo is on GitHub. Without `gh`, a task already `passed`
// whose branch is merged into the default branch counts too (only `passed`: a fresh branch with no
// commits would otherwise look merged). Done tasks lose their worktree (when it has no uncommitted
// changes) and their escalation is archived. Dependents become buildable.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadBoard, setStatus } from './board.mjs';
import { archiveEscalation } from './escalations.mjs';
import { repoRootFor } from './runs.mjs';

/** task/TASK-101 and task/TASK-101-build both belong to TASK-101. */
export function taskOfBranch(branch) {
  return /^task\/((?:TASK|FIX|QUICK)-[^-/\s]+)/.exec(branch ?? '')?.[1] ?? null;
}

const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 20_000 });

/** Task ids whose task/<ID> PR is merged on GitHub, or null when gh cannot answer. */
export function mergedOnGitHub(root, run = sh) {
  const r = run('gh', ['pr', 'list', '--state', 'merged', '--search', 'head:task/', '--limit', '200', '--json', 'headRefName'], root);
  if (r.error || r.status !== 0) return null;
  try {
    return new Set(JSON.parse(r.stdout).map((p) => taskOfBranch(p.headRefName)).filter(Boolean));
  } catch {
    return null;
  }
}

function defaultBranch(root) {
  const head = sh('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  if (head.status === 0) return head.stdout.trim();
  for (const b of ['main', 'master', 'dev']) if (sh('git', ['rev-parse', '--verify', b], root).status === 0) return b;
  return null;
}

/** Task ids whose task/<ID> branch is merged into the default branch locally. */
export function mergedLocally(root) {
  const base = defaultBranch(root);
  if (!base) return new Set();
  const r = sh('git', ['branch', '--format=%(refname:short)', '--merged', base], root);
  return new Set((r.stdout ?? '').split('\n').map((b) => taskOfBranch(b.trim())).filter(Boolean));
}

/**
 * @returns {{ done: string[], kept: string[], source: 'github' | 'git' }}
 */
export function syncRepo(repoRoot, { gh = mergedOnGitHub } = {}) {
  const root = repoRootFor(repoRoot);
  const board = loadBoard(root);
  if (!board) return { done: [], kept: [], source: 'git' };
  const fromGh = gh(root);
  const local = mergedLocally(root);
  const done = [];
  const kept = [];
  for (const t of board.list) {
    if (t.status === 'done') continue;
    const merged = fromGh?.has(t.id) || (t.status === 'passed' && local.has(t.id));
    if (!merged) continue;
    setStatus(root, t.id, 'done');
    archiveEscalation(root, t.id);
    done.push(t.id);
    const wt = path.join(root, '.role-router', 'worktrees', t.id);
    if (existsSync(path.join(wt, '.git'))) {
      const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no'], wt).stdout?.trim();
      if (dirty) { kept.push(`${t.id} (worktree has uncommitted changes)`); continue; }
      try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: root, stdio: 'ignore' }); } catch { kept.push(`${t.id} (worktree could not be removed)`); }
    }
  }
  return { done, kept, source: fromGh ? 'github' : 'git' };
}

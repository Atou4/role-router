// Role Router — one git worktree per task under <repo>/.role-router/worktrees/<id> (shared by fanout and launch).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ensureStateDir } from './runs.mjs';

/**
 * The task's worktree, created on branch task/<id> from `base` when missing. An existing worktree
 * (a task stopped on a limit or by the user) is reused so the next agent resumes in it.
 * @returns {string} worktree path
 */
export function ensureWorktree(repoRoot, id, base = 'HEAD') {
  const dir = path.join(ensureStateDir(repoRoot), 'worktrees', id);
  if (existsSync(path.join(dir, '.git'))) return dir;
  const branch = `task/${id}`;
  let exists = true;
  try { execFileSync('git', ['rev-parse', '--verify', branch], { cwd: repoRoot, stdio: 'ignore' }); } catch { exists = false; }
  try {
    execFileSync('git', ['worktree', 'add', dir, ...(exists ? [branch] : ['-b', branch, base])], { cwd: repoRoot, stdio: 'pipe' });
  } catch (e) {
    throw new Error(`worktree for ${id}: ${(e.stderr?.toString() || e.message).trim()}`);
  }
  return dir;
}

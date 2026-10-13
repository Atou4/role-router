// Role Router — one git worktree per task under <repo>/.role-router/worktrees/<id> (shared by fanout and launch).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureStateDir } from './runs.mjs';

/**
 * The task's worktree, created on branch task/<id> from `base` when missing. An existing worktree
 * (a task stopped on a limit or by the user) is reused so the next agent resumes in it.
 * @returns {string} worktree path
 */
export function ensureWorktree(repoRoot, id, base = 'HEAD', { setup = true } = {}) {
  const dir = path.join(ensureStateDir(repoRoot), 'worktrees', id);
  if (existsSync(path.join(dir, '.git'))) {
    if (setup) ensureDeps(dir);
    return dir;
  }
  const branch = `task/${id}`;
  let exists = true;
  try { execFileSync('git', ['rev-parse', '--verify', branch], { cwd: repoRoot, stdio: 'ignore' }); } catch { exists = false; }
  try {
    execFileSync('git', ['worktree', 'add', dir, ...(exists ? [branch] : ['-b', branch, base])], { cwd: repoRoot, stdio: 'pipe' });
  } catch (e) {
    throw new Error(`worktree for ${id}: ${(e.stderr?.toString() || e.message).trim()}`);
  }
  if (setup) ensureDeps(dir);
  return dir;
}

/**
 * The install command a fresh worktree needs, or null when its dependencies are already there.
 * A new worktree has none of the main checkout's untracked folders (node_modules, .dart_tool):
 * seen live, a reviewer found `prettier: command not found` in a task worktree.
 * ROLE_ROUTER_WORKTREE_SETUP overrides detection ("" disables it).
 */
export function setupCommand(dir, env = process.env) {
  if (env.ROLE_ROUTER_WORKTREE_SETUP !== undefined) return env.ROLE_ROUTER_WORKTREE_SETUP.trim() || null;
  const has = (f) => existsSync(path.join(dir, f));
  if (has('pnpm-lock.yaml')) return has('node_modules/.modules.yaml') ? null : 'pnpm install --frozen-lockfile --prefer-offline';
  if (has('package-lock.json')) return has('node_modules/.package-lock.json') ? null : 'npm ci --prefer-offline --no-audit --no-fund';
  if (has('yarn.lock')) return has('node_modules/.yarn-integrity') || has('node_modules/.yarn-state.yml') ? null : 'yarn install --frozen-lockfile';
  if (has('bun.lockb') || has('bun.lock')) return has('node_modules') ? null : 'bun install --frozen-lockfile';
  if (has('pubspec.yaml')) return has('.dart_tool/package_config.json') ? null : 'flutter pub get';
  return null;
}

/** Install a worktree's dependencies if needed. Never throws: a failed install is logged, and the agent can still fix its environment. */
export function ensureDeps(dir, run = (cmd) => spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8', timeout: 15 * 60_000 })) {
  const cmd = setupCommand(dir);
  if (!cmd) return { ran: null };
  const r = run(cmd);
  const ok = !r.error && r.status === 0;
  try { writeFileSync(`${dir}.setup.log`, `$ ${cmd}\nexit ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}`); } catch { /* best effort */ }
  return { ran: cmd, ok };
}

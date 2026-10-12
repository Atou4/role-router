// Role Router — which repos you use it in, so commands work from anywhere and plans can span repos.
//
// Every repo that gets a `.role-router/` folder is remembered in ~/.role-router/state/repos.json.
// That lets `role-router status` outside a repo list them, error messages point you at the right
// one, and a dependency like `IncaCook:TASK-102` find the IncaCook repo's board.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function registryPath() {
  const dir = process.env.ROLE_ROUTER_STATE_DIR || path.join(os.homedir(), '.role-router', 'state');
  return path.join(dir, 'repos.json');
}

function read() {
  try { return JSON.parse(readFileSync(registryPath(), 'utf8')); } catch { return {}; }
}

/** Remember a repo (by its main checkout). Cheap and idempotent; never throws. */
export function registerRepo(root) {
  try {
    const repos = read();
    if (repos[root]) return;
    repos[root] = { name: path.basename(root), firstSeen: new Date().toISOString() };
    const file = registryPath();
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(repos, null, 2) + '\n');
    renameSync(tmp, file);
  } catch { /* the registry is a convenience, never a reason to fail a run */ }
}

/** Known repos that still exist, as [{ root, name }]. */
export function knownRepos() {
  return Object.entries(read())
    .filter(([root]) => existsSync(path.join(root, '.git')))
    .map(([root, v]) => ({ root, name: v.name ?? path.basename(root) }));
}

/**
 * Resolve a repo name used in a qualified dependency (`IncaCook:TASK-102`): a sibling folder of
 * `fromRoot` first (plans usually span repos that live side by side), then the registry.
 */
export function resolveRepo(name, fromRoot) {
  const sibling = path.join(path.dirname(fromRoot), name);
  if (existsSync(path.join(sibling, '.git'))) return sibling;
  return knownRepos().find((r) => r.name === name)?.root ?? null;
}

/** The git top-level of `cwd`, or null outside a repo (no git noise on stderr). */
export function gitRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Like gitRoot, but outside a repo throws an Error that tells the user what to do instead. */
export function requireRepo(cwd = process.cwd(), command = '<command>') {
  const root = gitRoot(cwd);
  if (root) { registerRepo(root); return root; }
  const repos = knownRepos();
  const list = repos.length
    ? `\nRepos you have used role-router in:\n${repos.map((r) => `  ${r.root}`).join('\n')}`
    : '';
  throw new Error(`${cwd} is not inside a git repo. cd into the repo first, or run: role-router -C <repo> ${command}${list}`);
}

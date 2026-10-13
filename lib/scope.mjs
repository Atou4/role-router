// Role Router — which repos a command covers: the active project's (role-router -P <name>), or
// every repo role-router knows. Kept dependency-light so any module can use it.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { knownRepos } from './repos.mjs';

export function stateDir() {
  return process.env.ROLE_ROUTER_STATE_DIR || path.join(os.homedir(), '.role-router', 'state');
}
export const projectsDir = () => path.join(stateDir(), 'projects');
export const projectFile = (name) => path.join(projectsDir(), name, 'project.json');

/** The active project name (from -P), or null. */
export const activeProject = () => process.env.ROLE_ROUTER_PROJECT || null;

/** Repos in scope as [{ root, name }]. Throws a clear error for an unknown project. */
export function scopeRepos() {
  const name = activeProject();
  if (!name) return knownRepos();
  const file = projectFile(name);
  if (!existsSync(file)) throw new Error(`no project "${name}"; role-router project list shows them`);
  const project = JSON.parse(readFileSync(file, 'utf8'));
  return project.repos.filter((r) => existsSync(path.join(r, '.git'))).map((r) => ({ root: r, name: path.basename(r) }));
}

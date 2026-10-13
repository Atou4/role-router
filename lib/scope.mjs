// Role Router — which repos a command covers: the active project's (role-router -P <name>), or
// every repo role-router knows. Kept dependency-light so any module can use it.

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
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

/** Projects that include `root` (a main checkout), as [{ name, repos }]. */
export function projectsFor(root) {
  if (!existsSync(projectsDir())) return [];
  const out = [];
  for (const name of readdirSync(projectsDir())) {
    try {
      const p = JSON.parse(readFileSync(projectFile(name), 'utf8'));
      if (p.repos?.includes(root)) out.push(p);
    } catch { /* not a project */ }
  }
  return out;
}

export const decisionsFile = (name) => path.join(projectsDir(), name, 'decisions.md');

/** The project's decision entries (the template header removed), newest last. */
export function decisionEntries(name) {
  try {
    return readFileSync(decisionsFile(name), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('# ') && !/^Newest last\./.test(l));
  } catch { return []; }
}

/** Binding prompt block: recent decisions of every project this repo belongs to. Empty when none. */
export function decisionsPrompt(root, maxChars = 3000) {
  const blocks = [];
  for (const p of projectsFor(root)) {
    const entries = decisionEntries(p.name);
    if (!entries.length) continue;
    let text = entries.join('\n');
    if (text.length > maxChars) text = `(older decisions omitted)\n${text.slice(-maxChars)}`;
    blocks.push(`## Project decisions: ${p.name} (binding)\nDecisions the human made for this project. Apply the text after "DECISION:" exactly; the reason lines are context, not content. If your task conflicts with a decision, stop and escalate instead of choosing.\n${text}`);
  }
  return blocks.join('\n\n');
}

/** Append a decision to a project's log. */
export function appendDecision(name, { decision, why, affects = [], source }, now = new Date()) {
  if (!existsSync(projectFile(name))) throw new Error(`no project "${name}"`);
  if (!decision?.trim()) throw new Error('give the decision text');
  // The decision gets its own line, verbatim; the reason and scope are labelled lines under it.
  // Seen live: with "(why: …)" on the same line, a Builder copied the reason into the code.
  const entry = [
    `- ${now.toISOString().slice(0, 10)} · DECISION: ${decision.trim().replace(/\s+/g, ' ')}`,
    ...(why ? [`  - reason (context only, not part of the decision): ${why.trim()}`] : []),
    ...(affects.length ? [`  - affects: ${affects.join(', ')}`] : []),
    ...(source ? [`  - recorded by: ${source}`] : []),
  ].join('\n');
  appendFileSync(decisionsFile(name), `${entry}\n`);
  return entry;
}

/** Repos in scope as [{ root, name }]. Throws a clear error for an unknown project. */
export function scopeRepos() {
  const name = activeProject();
  if (!name) return knownRepos();
  const file = projectFile(name);
  if (!existsSync(file)) throw new Error(`no project "${name}"; role-router project list shows them`);
  const project = JSON.parse(readFileSync(file, 'utf8'));
  return project.repos.filter((r) => existsSync(path.join(r, '.git'))).map((r) => ({ root: r, name: path.basename(r) }));
}

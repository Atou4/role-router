// Role Router — which skills a Role run is handed, and where each agent can see them.
//
// Resolution: the Role's core skills, then stack rules for every stack detected in the
// repo, then optional skills, capped at manifest.maxSkills and filtered to what the target
// agent can actually read. The prompt gets absolute SKILL.md paths, which work the same
// on every agent regardless of how each one invokes skills natively.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills-manifest.json');
const ROLE_KEY = { architect: 'architect', builder: 'builder', escalation: 'escalation', worker: 'review', review: 'review', docs: 'docs' };

/** Skill folders each agent reads, in precedence order (repo-local first). */
export function skillRoots(agent, repoRoot, home = os.homedir()) {
  const claude = [path.join(repoRoot, '.claude', 'skills'), path.join(home, '.claude', 'skills')];
  const agents = [path.join(repoRoot, '.agents', 'skills'), path.join(home, '.agents', 'skills')];
  if (agent === 'claude') return claude;
  if (agent === 'codex') return agents;
  return [path.join(repoRoot, '.opencode', 'skills'), path.join(home, '.config', 'opencode', 'skills'), ...claude, ...agents];
}

export function loadManifest(file = MANIFEST) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Stacks whose detect rules match files at the repo root. */
export function detectStacks(manifest, repoRoot) {
  let entries;
  try { entries = readdirSync(repoRoot); } catch { return []; }
  const matches = (rule) => {
    if (rule.suffix) return entries.some((e) => e.endsWith(rule.suffix));
    if (rule.dir) return existsSync(path.join(repoRoot, rule.dir));
    const file = path.join(repoRoot, rule.file);
    if (!existsSync(file)) return false;
    if (!rule.contains) return true;
    const text = readFileSync(file, 'utf8');
    return rule.contains.some((needle) => text.includes(needle));
  };
  return Object.entries(manifest.stacks ?? {}).filter(([, s]) => s.detect.some(matches)).map(([name]) => name);
}

/**
 * @returns {{ stacks: string[], skills: Array<{ name: string, path: string, why: string }>, missing: string[], dropped: string[] }}
 */
export function resolveSkills({ role, agent, repoRoot, manifest = loadManifest(), home }) {
  const spec = manifest.roles[ROLE_KEY[role]];
  if (!spec) return { stacks: [], skills: [], missing: [], dropped: [] };
  const stacks = spec.stackRules ? detectStacks(manifest, repoRoot) : [];
  const wanted = [
    ...spec.core.map((name) => ({ name, why: 'core' })),
    ...stacks.flatMap((s) => manifest.stacks[s].skills.map((name) => ({ name, why: `stack: ${s}` }))),
    ...(spec.optional ?? []).map((name) => ({ name, why: 'optional' })),
  ].filter((s, i, all) => all.findIndex((t) => t.name === s.name) === i);

  const roots = skillRoots(agent, repoRoot, home);
  const skills = [];
  const missing = [];
  const dropped = [];
  for (const s of wanted) {
    const dir = roots.map((r) => path.join(r, s.name)).find((d) => existsSync(path.join(d, 'SKILL.md')));
    if (!dir) { if (s.why !== 'optional') missing.push(s.name); continue; }
    if (skills.length >= (manifest.maxSkills ?? 6)) { dropped.push(s.name); continue; }
    skills.push({ ...s, path: path.join(dir, 'SKILL.md') });
  }
  return { stacks, skills, missing, dropped };
}

/** The prompt block a role run is given. Empty string when there is nothing to hand over. */
export function renderSkillsBlock(resolved) {
  if (resolved.skills.length === 0) return '';
  const lines = resolved.skills.map((s) => `- \`${s.name}\` (${s.why}): ${s.path}`);
  return `## Skills for this run
Read a skill's SKILL.md in full when the step that needs it comes up (you may also load it by name if your harness supports skills). Do not load skills that are not listed here.${resolved.stacks.length ? `\nDetected stack: ${resolved.stacks.join(', ')}.` : ''}
${lines.join('\n')}`;
}

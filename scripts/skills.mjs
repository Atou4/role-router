#!/usr/bin/env node

// role-router skills — keep the skills this workflow uses installed and healthy.
//
//   role-router skills doctor                   per-agent check of the skills the roles use (read-only)
//   role-router skills install <group|role|all> [--dry-run]
//   role-router skills readme                   regenerate catalog/README.md from catalog/skills.json

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, resolveSkills, skillRoots } from '../lib/skills.mjs';
import { repoRootFor } from '../lib/runs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(path.join(ROOT, 'catalog', 'skills.json'), 'utf8'));
const entries = Object.entries(catalog.groups).flatMap(([group, g]) => g.skills.map((s) => ({ ...s, group })));
const HOME = os.homedir();
const AGENTS = ['claude', 'codex', 'opencode'];
const CODEX_FALLBACK_BUDGET = 8000; // Codex: the skills list gets ≤2% of the model's context window, 8,000 chars when the window is unknown

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yel = (s) => `\x1b[33m${s}\x1b[0m`;
const grn = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const installCommand = (s) =>
  s.source === 'local' ? null
    : `npx -y skills add ${s.source} --skill ${JSON.stringify(s.skill_id ?? s.name)} -g -y ${catalog.agents.map((a) => `-a ${a}`).join(' ')}`;

function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const desc = /^description:\s*(.*(?:\n\s+.*)*)/m.exec(fm)?.[1].replace(/\s+/g, ' ').replace(/^[>|-]+\s*/, '').replace(/^["']|["']$/g, '') ?? '';
  return { userOnly: /disable-model-invocation:\s*true/.test(fm), desc };
}

/** Every skill an agent sees (user-level folders only), name → SKILL.md path. */
function visible(agent) {
  const seen = new Map();
  for (const root of skillRoots(agent, '/nonexistent-repo', HOME)) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const file = path.join(root, name, 'SKILL.md');
      if (!seen.has(name) && existsSync(file)) seen.set(name, file);
    }
  }
  return seen;
}

function doctor() {
  const manifest = loadManifest();
  const repo = repoRootFor(process.cwd());
  let problems = 0;
  const flag = (msg) => { problems++; console.log(`  ${red('✗')} ${msg}`); };
  const ok = (msg) => console.log(`  ${grn('✓')} ${msg}`);
  const views = Object.fromEntries(AGENTS.map((a) => [a, visible(a)]));

  console.log('Role skills (skills-manifest.json)');
  const roleSkills = new Set([
    ...Object.values(manifest.roles).flatMap((r) => [...r.core, ...(r.optional ?? [])]),
    ...Object.values(manifest.stacks).flatMap((s) => s.skills),
  ]);
  for (const name of roleSkills) {
    const where = AGENTS.filter((a) => views[a].has(name));
    const file = where.length ? views[where[0]].get(name) : null;
    if (!file) { flag(`${name}: not installed for any agent${installHint(name)}`); continue; }
    if (frontmatter(file).userOnly) flag(`${name}: user-only (disable-model-invocation), a role cannot load it`);
    if (where.length < AGENTS.length) flag(`${name}: missing for ${AGENTS.filter((a) => !where.includes(a)).join(', ')}${installHint(name)}`);
    else ok(dim(name));
  }

  console.log('\nThis repo');
  for (const role of Object.keys(manifest.roles)) {
    const r = resolveSkills({ role, agent: 'codex', repoRoot: repo, manifest });
    console.log(`  ${role.padEnd(11)} ${r.skills.map((s) => s.name).join(', ') || '-'}${r.stacks.length ? dim(`  [${r.stacks.join(', ')}]`) : ''}${r.dropped.length ? yel(`  over cap: ${r.dropped.join(', ')}`) : ''}`);
  }

  console.log('\nInstalled but not used by Role Router (info only; your machine, your call)');
  let any = false;
  for (const [name, why] of Object.entries(catalog.obsolete)) {
    const where = AGENTS.filter((a) => views[a].has(name));
    if (where.length) { any = true; console.log(`  ${dim(`${name}: ${why}`)}`); }
  }
  if (!any) console.log(`  ${dim('none')}`);

  console.log('\nDiverged copies of role skills (same name, different content in ~/.claude and ~/.agents)');
  any = false;
  for (const name of roleSkills) {
    const file = views.claude.get(name);
    const other = path.join(HOME, '.agents', 'skills', name, 'SKILL.md');
    if (!file || !existsSync(other) || realpathSync(file) === realpathSync(other)) continue;
    if (readFileSync(file, 'utf8') !== readFileSync(other, 'utf8')) { any = true; flag(`${name}: ${file} ≠ ${other}`); }
  }
  if (!any) ok('none');

  console.log('\nSkill-list budget');
  for (const a of AGENTS) {
    const chars = [...views[a].values()].reduce((n, f) => n + frontmatter(f).desc.length, 0);
    const msg = `${a.padEnd(9)} ${String(views[a].size).padStart(3)} skills, ${chars} description chars`;
    console.log(`  ${a === 'codex' && chars > CODEX_FALLBACK_BUDGET ? yel(`${msg}  (over Codex's ${CODEX_FALLBACK_BUDGET}-char fallback; fine on large-context models, trimmed on small ones)`) : dim(msg)}`);
  }
  const legacy = path.join(HOME, '.codex', 'skills');
  if (existsSync(legacy)) console.log(dim(`  note: ${legacy} has ${readdirSync(legacy).length} entries; current Codex docs only list ~/.agents/skills`));

  console.log(problems ? `\n${problems} problem(s).` : `\n${grn('All good.')}`);
  process.exitCode = problems ? 1 : 0;
}

function installHint(name) {
  const e = entries.find((s) => s.name === name);
  const cmd = e && installCommand(e);
  return cmd ? dim(`\n      ${cmd}`) : '';
}

function install(selector, dryRun) {
  const picked = selector === 'all' ? entries
    : catalog.groups[selector] ? entries.filter((s) => s.group === selector)
    : entries.filter((s) => s.use === selector);
  if (!picked.length) {
    console.error(`Unknown selector "${selector}". Use all, a group (${Object.keys(catalog.groups).join(', ')}), or a use (architect, builder, review, docs, human).`);
    process.exit(1);
  }
  for (const s of picked) {
    const cmd = installCommand(s);
    if (!cmd) { console.log(`  skip     ${s.name.padEnd(32)} ${dim('local skill, no upstream')}`); continue; }
    console.log(`  install  ${s.name.padEnd(32)} ${dim(s.source)}`);
    if (dryRun) { console.log(dim(`           ${cmd}`)); continue; }
    const r = spawnSync('bash', ['-c', cmd], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) console.log(yel(`           failed; try: npx skills add ${s.source}`));
  }
}

function readme() {
  const rows = (g) => g.skills.map((s) =>
    `| ${s.name} | ${s.use} | ${s.invocation === 'user' ? 'you' : 'model'} | \`${s.source}\` | ${s.license} | ${s.description} |`).join('\n');
  const body = `# Skill catalog

Generated from [\`skills.json\`](./skills.json) by \`role-router skills readme\`; edit the JSON, not this file.

Skills are not vendored: each entry points at its upstream source. **use** is who calls it: a Role (handed to it by dispatch via [\`skills-manifest.json\`](../skills-manifest.json)) or **human** for skills you invoke yourself. **loaded by** \`you\` means the skill sets \`disable-model-invocation\`, so no role can load it.

\`\`\`bash
role-router skills install all            # or a group, or a use: architect | builder | review | docs | human
role-router skills doctor                 # per-agent check: missing, user-only, obsolete, diverged, budget
\`\`\`

Installs go to Claude Code, Codex and OpenCode together (\`${catalog.agents.join(', ')}\`).

${Object.values(catalog.groups).map((g) => `## ${g.label}\n| Skill | Use | Loaded by | Source | License | What it does |\n|---|---|---|---|---|---|\n${rows(g)}`).join('\n\n')}

## Obsolete
${Object.entries(catalog.obsolete).map(([n, why]) => `- \`${n}\`: ${why}`).join('\n')}
`;
  writeFileSync(path.join(ROOT, 'catalog', 'README.md'), body);
  console.log('catalog/README.md regenerated');
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'doctor') doctor();
else if (cmd === 'install' && arg) install(arg, process.argv.includes('--dry-run'));
else if (cmd === 'readme') readme();
else { console.error('usage: role-router skills doctor | install <all|group|use> [--dry-run] | readme'); process.exit(1); }

#!/usr/bin/env node

// role-router project create <name> --repos A,B,C [--profile ID]
// role-router project list | show <name>
// role-router project add <name> <repo…> | remove <name> <repo…>
// role-router project set <name> --profile ID     (--profile "" goes back to the Architect chain)
// role-router project open <name> [--profile ID] [--fresh] [--print]
//
// `open` starts (or resumes) the project's Architect session: one conversation for planning,
// decisions, unblocking and dispatching across the project's repos. A live brief built from the
// files is handed over every time, so the conversation never acts on stale state.
// Scope any other command to the project with: role-router -P <name> <command>

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { dispatch } from '../lib/dispatch.mjs';
import { loadConfig } from '../lib/config.mjs';
import { buildBrief, createProject, decisionsPath, findCodexSession, listProjects, loadProject, projectDir, rememberSession, sessionProfile, sessionRules, updateProject } from '../lib/projects.mjs';
import { syncRepo } from '../lib/sync.mjs';

const [cmd, name, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf(`--${n}`); return i !== -1 ? rest[i + 1] : rest.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3); };
const has = (n) => rest.includes(`--${n}`);
const positional = rest.filter((a, i) => !a.startsWith('--') && !['--repos', '--profile'].includes(rest[i - 1]));
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function describe(p) {
  console.log(`${p.name}  ${dim(`session: ${p.profile ?? 'Architect chain'}`)}`);
  for (const r of p.repos) console.log(`  ${path.basename(r).padEnd(22)} ${dim(r)}`);
  const s = Object.entries(p.sessions ?? {});
  if (s.length) console.log(dim(`  sessions: ${s.map(([k, v]) => `${k} (${v.at.slice(0, 16).replace('T', ' ')})`).join(', ')}`));
}

try {
  if (cmd === 'create') {
    const repos = (opt('repos') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const p = createProject(name, [...repos, ...positional], { profile: opt('profile') || undefined });
    describe(p);
    console.log(`\nOpen its Architect session: role-router project open ${p.name}\nScope any command:        role-router -P ${p.name} status | inbox | launch --ready --detach | watch`);
  } else if (cmd === 'list' || !cmd) {
    const all = listProjects();
    if (!all.length) console.log('No projects yet: role-router project create <name> --repos A,B,C');
    all.forEach(describe);
  } else if (cmd === 'show') {
    describe(loadProject(name));
    console.log(dim(`  decisions: ${decisionsPath(name)}`));
  } else if (cmd === 'add' || cmd === 'remove') {
    describe(updateProject(name, cmd === 'add' ? { addRepos: positional } : { removeRepos: positional }));
  } else if (cmd === 'set') {
    describe(updateProject(name, { profile: opt('profile') ?? undefined }));
  } else if (cmd === 'open') {
    const project = loadProject(name);
    for (const r of project.repos) { try { syncRepo(r); } catch { /* best effort */ } }
    const profileId = sessionProfile(project, opt('profile'));
    const agent = loadConfig().accounts[loadConfig().profiles[profileId].account].agent;
    const brief = buildBrief(project);
    writeFileSync(path.join(projectDir(name), 'brief.md'), brief);
    const previous = has('fresh') ? null : project.sessions?.[profileId]?.id;
    const message = previous
      ? `Session reopened. Here is the current brief; it overrides anything older in this conversation.\n\n${brief}\nSummarise in a few lines what changed and what needs my attention, then wait.`
      : `${sessionRules(project)}\n\n---\n\n${brief}\nStart with a short summary of what needs my attention, then wait for instructions.`;
    const sessionId = !previous && agent === 'claude' ? randomUUID() : undefined;
    const request = {
      role: 'architect', raw: true, message, mode: 'interactive', cwd: projectDir(name),
      profile: profileId, resume: previous ?? undefined, sessionId, addDirs: project.repos, fullAccess: true,
    };
    if (has('print')) {
      const plan = await dispatch({ ...request, dryRun: true });
      console.log(JSON.stringify({ project: name, profile: profileId, agent, resume: previous ?? null, cwd: request.cwd, launch: plan.plan[0] }, null, 2));
      console.log(`\n--- message ---\n${message}`);
      process.exit(0);
    }
    console.log(dim(`Opening ${name} on ${profileId}${previous ? ' (resuming)' : ''}. Brief: ${path.join(projectDir(name), 'brief.md')}`));
    if (sessionId) rememberSession(name, profileId, sessionId);
    const started = new Date();
    const out = await dispatch(request);
    if (agent === 'codex' && !previous) {
      const id = findCodexSession(projectDir(name), started);
      if (id) rememberSession(name, profileId, id);
    } else if (previous) rememberSession(name, profileId, previous);
    if (out.status !== 'ok' && previous) console.error(`role-router: the session could not be resumed; start a new one with: role-router project open ${name} --fresh`);
    process.exit(out.status === 'ok' ? 0 : 1);
  } else {
    throw new Error('usage: role-router project create|list|show|add|remove|set|open … (see role-router project --help in README)');
  }
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}

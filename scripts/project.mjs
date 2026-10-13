#!/usr/bin/env node

// role-router project create <name> --repos A,B,C [--profile ID]
// role-router project list | show <name>
// role-router project add <name> <repo…> | remove <name> <repo…>
// role-router project set <name> --profile ID     (--profile "" goes back to the Architect chain)
// role-router project open <name> [--profile ID] [--fresh] [--print] [--read-only]
// role-router project decide <name> "<decision>" [--why "…"] [--affects Repo:TASK,…]   append to the decision log
// role-router project ask <name> "<message>" [--profile ID] [--fresh] [--act]   one message, same session, no screen;
//                                                                read-only unless --act
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
import { appendDecision } from '../lib/scope.mjs';

const [cmd, name, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf(`--${n}`); return i !== -1 ? rest[i + 1] : rest.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3); };
const has = (n) => rest.includes(`--${n}`);
const positional = rest.filter((a, i) => !a.startsWith('--') && !['--repos', '--profile', '--why', '--affects'].includes(rest[i - 1]));
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
  } else if (cmd === 'decide') {
    const text = positional.join(' ').trim();
    const affects = (opt('affects') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    loadProject(name);
    console.log(appendDecision(name, { decision: text, why: opt('why'), affects, source: 'decide' }));
    console.log(dim('Every task prompt in this project now carries it.'));
  } else if (cmd === 'ask') {
    // One message to the project's session, no interactive screen: same conversation as `open`.
    const question = positional.join(' ').trim();
    if (!question) throw new Error('usage: role-router project ask <name> "<message>" [--profile ID] [--fresh]');
    const project = loadProject(name);
    const profileId = sessionProfile(project, opt('profile'));
    const agent = loadConfig().accounts[loadConfig().profiles[profileId].account].agent;
    const brief = buildBrief(project);
    writeFileSync(path.join(projectDir(name), 'brief.md'), brief);
    const previous = has('fresh') ? null : project.sessions?.[profileId]?.id;
    const oneShot = has('act')
      ? 'This message arrives without an interactive back-and-forth: answer it, and take state-changing actions only if this message explicitly asks for them.'
      : 'This message arrives without an interactive back-and-forth, in a READ-ONLY session: role-router refuses every command that changes state or spends agent time. Answer from the brief and read-only commands; where an action is needed, give the exact command for the human to run.';
    const message = previous
      ? `Current brief (overrides anything older in this conversation):\n\n${brief}\n---\n${oneShot}\n\n${question}`
      : `${sessionRules(project)}\n\n---\n\n${brief}\n---\n${oneShot}\n\n${question}`;
    const sessionId = !previous && agent === 'claude' ? randomUUID() : undefined;
    if (!has('act')) process.env.ROLE_ROUTER_READONLY = '1'; // enforced by the launcher inside the session
    const out = await dispatch({
      role: 'architect', raw: true, message, mode: 'headless', cwd: projectDir(name), task: `project-${name}`,
      profile: profileId, resume: previous ?? undefined, sessionId, addDirs: project.repos, fullAccess: true, timeoutMinutes: 30,
    });
    const last = out.runs.at(-1)?.result;
    const id = last?.sessionId ?? sessionId ?? previous;
    if (out.status === 'ok' && id) rememberSession(name, profileId, id);
    if (out.status !== 'ok') throw new Error(`${out.status}: ${out.message ?? last?.message ?? 'no answer'}${previous ? ` (if the old session is gone: --fresh)` : ''}`);
    console.log(last?.summary ?? '(no text answer)');
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
    if (has('read-only')) process.env.ROLE_ROUTER_READONLY = '1';
    console.log(dim(`Opening ${name} on ${profileId}${previous ? ' (resuming)' : ''}${has('read-only') ? ', read-only' : ''}. Brief: ${path.join(projectDir(name), 'brief.md')}`));
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

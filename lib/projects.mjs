// Role Router — projects: a named group of repos (one product) with its own Architect session.
//
//   ~/.role-router/state/projects/<name>/project.json   repos, preferred session profile, session ids
//   ~/.role-router/state/projects/<name>/decisions.md   the project's decision log (private)
//   ~/.role-router/state/projects/<name>/brief.md       the live brief written at each `project open`
//
// Files stay the truth: every time the session opens, a brief is regenerated from the boards, the
// inbox, running work and recent decisions, and it overrides anything older in the conversation.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listActive } from './active.mjs';
import { accountStates } from './accounts.mjs';
import { depStatus, isBuildable, loadBoard } from './board.mjs';
import { loadConfig } from './config.mjs';
import { listEscalations } from './escalations.mjs';
import { listLaunches } from './launch.mjs';
import { gitRoot, knownRepos, registerRepo, resolveRepo } from './repos.mjs';
import { repoRootFor } from './runs.mjs';
import { projectFile, projectsDir } from './scope.mjs';

const NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/i;
export const projectDir = (name) => path.dirname(projectFile(name));
export const decisionsPath = (name) => path.join(projectDir(name), 'decisions.md');

function save(project) {
  mkdirSync(projectDir(project.name), { recursive: true });
  const file = projectFile(project.name);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(project, null, 2) + '\n');
  renameSync(tmp, file);
  return project;
}

export function loadProject(name) {
  const file = projectFile(name);
  if (!existsSync(file)) throw new Error(`no project "${name}"; role-router project list shows them`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function listProjects() {
  if (!existsSync(projectsDir())) return [];
  return readdirSync(projectsDir()).filter((n) => existsSync(projectFile(n))).sort().map(loadProject);
}

/** Resolve repo specs (folder names next to `cwd`'s repo or known to role-router, or paths) to main checkouts. */
export function resolveRepoSpecs(specs, cwd = process.cwd()) {
  const here = gitRoot(cwd);
  return specs.map((spec) => {
    const asPath = path.resolve(cwd, spec);
    const root = existsSync(path.join(asPath, '.git')) ? asPath : resolveRepo(spec, here ? repoRootFor(here) : path.join(cwd, '_'));
    if (!root) throw new Error(`no repo "${spec}": give a path, or a folder name next to this repo or known to role-router`);
    return repoRootFor(root);
  });
}

export function createProject(name, repoSpecs, { profile, cwd } = {}) {
  if (!NAME.test(name)) throw new Error('project names use letters, digits, dot, dash or underscore');
  if (existsSync(projectFile(name))) throw new Error(`project "${name}" already exists`);
  if (!repoSpecs.length) throw new Error('give the project at least one repo (--repos A,B,C)');
  const repos = [...new Set(resolveRepoSpecs(repoSpecs, cwd))];
  repos.forEach(registerRepo);
  if (profile) checkProfile(profile);
  mkdirSync(projectDir(name), { recursive: true });
  writeFileSync(decisionsPath(name), `# ${name} decision log\n\nNewest last. Each entry: date, the decision, why, tasks affected.\n`);
  return save({ name, repos, ...(profile && { profile }), sessions: {}, createdAt: new Date().toISOString() });
}

function checkProfile(profile) {
  const config = loadConfig();
  if (!config.profiles[profile]) throw new Error(`unknown profile "${profile}"; known: ${Object.keys(config.profiles).join(', ')}`);
}

export function updateProject(name, { addRepos = [], removeRepos = [], profile, cwd } = {}) {
  const p = loadProject(name);
  const add = resolveRepoSpecs(addRepos, cwd);
  add.forEach(registerRepo);
  const remove = new Set(resolveRepoSpecs(removeRepos, cwd));
  p.repos = [...new Set([...p.repos, ...add])].filter((r) => !remove.has(r));
  if (profile !== undefined) {
    if (profile) { checkProfile(profile); p.profile = profile; } else delete p.profile;
  }
  return save(p);
}

export function rememberSession(name, profileId, sessionId) {
  const p = loadProject(name);
  p.sessions = { ...p.sessions, [profileId]: { id: sessionId, at: new Date().toISOString() } };
  return save(p);
}

/** Which profile hosts the session: explicit choice, then the project's, then the Architect chain. */
export function sessionProfile(project, explicit) {
  const config = loadConfig();
  const choice = explicit ?? project.profile;
  if (choice) {
    if (!config.profiles[choice]) throw new Error(`unknown profile "${choice}"`);
    return choice;
  }
  const paused = new Set(accountStates(config).filter((s) => s.pausedUntil).map((s) => s.account));
  const chain = config.roles.architect?.chain ?? Object.keys(config.profiles);
  return chain.find((id) => !paused.has(config.profiles[id].account)) ?? chain[0];
}

const fmt = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 16);

/** The live brief: current state of every repo in the project, from files. */
export function buildBrief(project, now = new Date()) {
  const lines = [`# ${project.name}: live brief (${fmt(now)} UTC)`, '', 'This brief is regenerated from the files every time this session opens. Where it disagrees with anything earlier in this conversation, the brief is right.', ''];
  lines.push('## Repos');
  for (const root of project.repos) {
    const branch = (() => { try { return readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim().replace('ref: refs/heads/', ''); } catch { return '?'; } })();
    lines.push(`- **${path.basename(root)}**: ${root} (checked out: ${branch})`);
  }
  lines.push('', '## Boards');
  for (const root of project.repos) {
    const board = loadBoard(root);
    lines.push(`### ${path.basename(root)}`);
    if (!board) { lines.push('(no tasks)'); continue; }
    for (const t of board.list) {
      const open = t.depends.filter((d) => depStatus(board, d) !== 'done');
      const tag = isBuildable(t, board) ? ' — BUILDABLE' : open.length && t.status === 'planned' ? ` — waits on ${open.join(', ')}` : '';
      lines.push(`- ${t.id} ${t.status}: ${t.title}${tag}`);
    }
  }
  const inbox = listEscalations(project.repos);
  lines.push('', `## Inbox (${inbox.length} waiting on the human)`);
  for (const e of inbox) {
    lines.push(`- ${e.repo}:${e.task} [${e.type}] ${e.question}`);
    e.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o}`));
    if (e.blocks.length) lines.push(`  blocks: ${e.blocks.join(', ')}`);
  }
  const active = project.repos.flatMap((r) => listActive(r).map((a) => `- ${path.basename(r)}:${a.task} ${a.operation} on ${a.profile} since ${fmt(a.startedAt)}`));
  const launches = listLaunches().filter((l) => l.tasks.some((t) => project.repos.includes(t.repoRoot))).slice(0, 3);
  lines.push('', '## Running now', ...(active.length ? active : ['(nothing)']));
  if (launches.length) {
    lines.push('', '## Recent launches');
    for (const l of launches) lines.push(`- ${l.id}${l.running ? ' (running)' : ''}: ${l.tasks.map((t) => `${t.repo}:${t.id}=${t.stop ?? t.state}`).join(', ')}`);
  }
  let accounts = [];
  try { accounts = accountStates(loadConfig(), now); } catch { /* no config */ }
  lines.push('', '## Accounts', accounts.map((a) => (a.pausedUntil ? `${a.account} paused until ${fmt(a.pausedUntil)} (${a.reason})` : `${a.account} ok`)).join(' · ') || '(no config)');
  const log = existsSync(decisionsPath(project.name)) ? readFileSync(decisionsPath(project.name), 'utf8').trim().split('\n') : [];
  lines.push('', '## Recent decisions (tail of the decision log)', ...(log.length > 3 ? log.slice(-25) : ['(none yet)']));
  return lines.join('\n') + '\n';
}

/** The standing instructions for the project's Architect session. */
export function sessionRules(project) {
  const P = `role-router -P ${project.name}`;
  return `You are the Architect and orchestrator for the project "${project.name}" (${project.repos.map((r) => path.basename(r)).join(', ')}). The human uses this one conversation to plan, decide, unblock and dispatch work across all of these repos.

Rules:
- Files are the truth. The live brief below reflects them as of this opening; re-check with \`${P} status\`, \`${P} inbox\` or \`${P} watch --once\` before acting on an older memory.
- You do not write feature code here. Builders do that in task worktrees. You may edit plans/specs (PLAN.md, task specs) and commit them on each repo's checked-out default branch.
- Act through role-router so everything stays visible: \`${P} status\`, \`${P} inbox\`, \`role-router resolve <Repo:TASK> --option N|--note "…"\`, \`${P} sync\`, \`${P} launch <Repo:TASK…>|--ready --detach --yes\`, \`role-router stop <Repo:TASK>\`, \`role-router pr <Repo:TASK…>\`, \`role-router fan "<question>"\` for other models' views, and \`role-router -C <repo> board set-status <TASK> <status>\`.
- Only these commands are read-only and free to run: \`${P} status\`, \`${P} inbox\`, \`${P} watch --once\`, \`role-router -C <repo> board list|status <TASK>\`, \`role-router limits\`, \`role-router project show ${project.name}\`.
- Everything else changes state or spends agent time, including \`next\`, \`run\`, \`fix\`, \`quick\`, \`fanout\`, \`launch\`, \`fan\`, \`resolve\`, \`stop\`, \`pr\`, \`sync\`, \`board set-status\` and plan edits: say exactly what you will run and wait for the human's yes. Never run one of them to "check" something.
- If role-router answers "refused in a read-only session", do not work around it: give the human the exact command instead.
- When the human decides something, append it to ${decisionsPath(project.name)}: date, decision, why, tasks affected. Keep entries short.
- For a stuck task, read its run records (<repo>/.role-router/runs/<TASK>/*.json, the last messages) and its escalation (<repo>/.role-router/escalations/<TASK>.md) before proposing anything.`;
}

/** Newest Codex session started at or after `since` whose working folder is `cwd`. */
export function findCodexSession(cwd, since, root = path.join(process.env.HOME ?? '', '.codex', 'sessions')) {
  const days = [0, 1].map((d) => new Date(since.getTime() + d * 864e5)).map((d) => path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  let best = null;
  for (const dir of new Set(days)) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      try {
        const first = readFileSync(path.join(dir, f), 'utf8').split('\n', 1)[0];
        const meta = JSON.parse(first);
        const p = meta.payload ?? {};
        if (meta.type !== 'session_meta' || path.resolve(p.cwd ?? '') !== path.resolve(cwd)) continue;
        const at = new Date(p.timestamp ?? meta.timestamp);
        if (at >= new Date(since.getTime() - 5000) && (!best || at > best.at)) best = { id: p.id ?? p.session_id, at };
      } catch { /* not a session file */ }
    }
  }
  return best?.id ?? null;
}

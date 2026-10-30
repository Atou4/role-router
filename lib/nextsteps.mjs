// Role Router — what to do next, worked out from the files (no model involved).
//
// suggestions() looks at every repo in scope: passed tasks (open a PR / rework it from PR feedback /
// merge it / sync after a merge), the inbox (decide), buildable work (launch), and blocked tasks (explain what they wait
// on). Each suggestion carries the exact command, how it is handed to the project agent, and how
// many tasks it unblocks down the dependency chain (also across repos); the list is ranked by that.

import path from 'node:path';
import { listActive } from './active.mjs';
import { depStatus, isBuildable, isRunnable, loadBoard } from './board.mjs';
import { listEscalations } from './escalations.mjs';
import { listLaunches } from './launch.mjs';
import { projectsFor } from './scope.mjs';
import { isGitHub, pullRequests, readPrState, reworkReason } from './prflow.mjs';
import { baseBranch, taskBranch } from './pr.mjs';

/**
 * @typedef {object} Suggestion
 * @property {'merge'|'pr'|'sync'|'rework'|'decide'|'launch'} kind
 * @property {string} title       one line for humans
 * @property {string[]} argv      the role-router command (without the launcher), [] when the step is yours alone
 * @property {string} [note]      extra line (e.g. the PR link)
 * @property {string} agent       the instruction handed to the project agent
 * @property {boolean} act        whether the agent may act (routine) or only propose (decisions)
 * @property {number} unblocks    tasks waiting on this step, transitively
 * @property {string} [project]
 * @property {string} repoRoot
 */

/** Rank steps and explain what blocked tasks wait on, for the repos in scope. */
export function suggestions(repos, { prs = pullRequests } = {}) {
  const roots = repos.map((r) => r.root);
  const boards = new Map(roots.map((r) => [r, loadBoard(r)]));
  const key = (root, id) => `${path.basename(root)}:${id}`;
  // Reverse dependency graph across the scope (Repo:TASK dependencies included).
  const dependents = new Map();
  for (const [root, board] of boards) {
    for (const t of board?.list ?? []) {
      for (const d of t.depends) {
        const target = d.includes(':') ? d : key(root, d);
        if (!dependents.has(target)) dependents.set(target, new Set());
        dependents.get(target).add(key(root, t.id));
      }
    }
  }
  const unblockCount = (k, seen = new Set()) => {
    for (const next of dependents.get(k) ?? []) if (!seen.has(next)) { seen.add(next); unblockCount(next, seen); }
    return seen.size;
  };
  const busy = new Set();
  for (const root of roots) for (const a of listActive(root)) busy.add(key(root, a.task));
  for (const l of listLaunches().filter((x) => x.running)) for (const t of l.tasks) if (['queued', 'running', 'waiting'].includes(t.state)) busy.add(key(t.repoRoot, t.id));

  const remotes = new Map();
  const github = (root) => { if (!remotes.has(root)) remotes.set(root, isGitHub(root)); return remotes.get(root); };
  const out = [];
  const inbox = listEscalations(roots);
  const inInbox = new Set(inbox.map((e) => key(e.repoRoot, e.task)));
  const projectOf = (root) => projectsFor(root)[0]?.name;

  for (const [root, board] of boards) {
    if (!board) continue;
    const prMap = board.list.some((t) => t.status === 'passed') ? prs(root) : null; // gh, cached for a minute
    for (const t of board.list) {
      const k = key(root, t.id);
      if (busy.has(k)) continue;
      const base = { repoRoot: root, project: projectOf(root), unblocks: unblockCount(k) };
      if (t.status === 'passed') {
        const pr = prMap?.get(t.id);
        if (pr?.state === 'MERGED') {
          out.push({ ...base, kind: 'sync', title: `${k} was merged: mark it done`, argv: ['sync'], cwd: root, agent: `Run role-router -C ${root} sync.`, act: true });
        } else if (pr?.state === 'OPEN' && reworkReason(pr, readPrState(root, t.id))) {
          const why = reworkReason(pr, readPrState(root, t.id));
          out.push({ ...base, kind: 'rework', title: `Rework ${k} from PR #${pr.number} feedback (${why})`, argv: ['launch', k, '--detach', '--yes'], note: pr.url, agent: `Launch the rework of ${k} from its PR feedback: role-router launch ${k} --detach --yes.`, act: true });
        } else if (pr?.state === 'OPEN') {
          const state = pr.checks === 'failing' ? 'CI failing' : pr.checks === 'pending' ? 'CI running' : pr.review === 'CHANGES_REQUESTED' ? 'changes requested' : 'ready';
          out.push({ ...base, kind: 'merge', title: `Review & merge ${k}'s PR #${pr.number} (${state})`, argv: [], note: `${pr.url}   then: role-router sync`, agent: `Summarise PR #${pr.number} (${pr.url}) for ${k}: what changed, CI, open comments, and whether it is safe to merge. Do not merge.`, act: false });
        } else if (prMap) {
          out.push({ ...base, kind: 'pr', title: `Open the PR for ${k}`, argv: ['pr', k], agent: `Open the PR for ${k} with role-router pr ${k}.`, act: true });
        } else if (!github(root)) {
          // No GitHub: there is no PR to open; the human gate is merging the branch locally.
          const branch = taskBranch(root, t.id) ?? `task/${t.id}`;
          const into = baseBranch(root, t.id, branch);
          out.push({ ...base, kind: 'merge', title: `Merge ${k} (${branch}) into ${into} yourself`, argv: [], note: `git checkout ${into} && git merge ${branch}   then: role-router sync`, agent: `Summarise what ${branch} changes for ${k} and whether it is safe to merge into ${into}. Do not merge.`, act: false });
        } else {
          // On GitHub but the lookup failed: never guess "no PR" (that would suggest a duplicate).
          out.push({ ...base, kind: 'merge', title: `Check ${k}'s PR: GitHub could not be asked`, argv: [], note: 'gh auth status, then role-router pr ' + k + ' --dry-run', agent: `Find out whether ${k} has an open PR (gh pr list) and say what to do next. Change nothing.`, act: false });
        }
      }
    }
    const ready = board.list.filter((t) => !busy.has(key(root, t.id)) && isRunnable(t, board) && !inInbox.has(key(root, t.id)));
    if (ready.length) {
      const ids = ready.map((t) => key(root, t.id));
      out.push({
        repoRoot: root, project: projectOf(root), kind: 'launch', unblocks: ids.reduce((n, k) => n + unblockCount(k), 0),
        title: `Launch ${ids.join(', ')}`, argv: ['launch', ...ids, '--detach', '--yes'],
        agent: `Launch ${ids.join(', ')} with role-router launch ${ids.join(' ')} --detach --yes.`, act: true,
      });
    }
  }
  for (const e of inbox) {
    const k = key(e.repoRoot, e.task);
    if (e.pending) { // decided, but the Architect run that applies it failed: retrying is routine
      out.push({
        repoRoot: e.repoRoot, project: projectOf(e.repoRoot), kind: 'decide', unblocks: unblockCount(k),
        title: `Apply the decision for ${k} again (the Architect failed: ${String(e.pending.unapplied).slice(0, 60)})`, argv: ['resolve', k],
        agent: `Retry applying the recorded decision for ${k}: role-router resolve ${k}.`, act: true,
      });
      continue;
    }
    const rec = /^\s*(\d+)/.exec(e.recommendation ?? '')?.[1];
    const argv = rec && e.options[Number(rec) - 1] ? ['resolve', k, '--option', rec] : ['inbox'];
    out.push({
      repoRoot: e.repoRoot, project: projectOf(e.repoRoot), kind: 'decide', unblocks: unblockCount(k),
      title: `Decide ${k} [${e.type}]: ${e.question.slice(0, 80)}`, argv,
      note: rec ? `recommended: option ${rec}` : 'role-router inbox shows the options',
      agent: `Read ${k}'s escalation and run records, then recommend how to resolve it and give me the exact role-router resolve command. Do not resolve it.`, act: false,
    });
  }
  out.sort((a, b) => b.unblocks - a.unblocks || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

  // Blocked work, explained: the first not-done dependency of each planned task that is not buildable.
  const blocked = [];
  for (const [root, board] of boards) {
    for (const t of board?.list ?? []) {
      if (!['planned', 'gaps_found'].includes(t.status) || isRunnable(t, board)) continue;
      const waits = t.depends.filter((d) => depStatus(board, d) !== 'done').map((d) => `${d} (${depStatus(board, d) ?? 'unknown'})`);
      if (waits.length) blocked.push(`${key(root, t.id)} waits on ${waits.join(', ')}`);
    }
  }
  return { steps: out, blocked };
}

const ORDER = ['sync', 'rework', 'merge', 'pr', 'decide', 'launch'];

/** The NEXT panel. Collapsed to one line while work is running. */
export function renderNext({ steps, blocked }, { running = false, max = 6 } = {}) {
  if (!steps.length) {
    return blocked.length ? `NEXT  nothing to do until blocked work frees up; e.g. ${blocked[0]}` : 'NEXT  nothing waiting: plan more work (role-router project open <name>) or run role-router launch --ready';
  }
  const cmd = (s) => (s.argv.length ? `role-router ${s.cwd ? `-C ${s.cwd} ` : ''}${s.argv.join(' ')}` : '');
  if (running) return `NEXT  ${steps[0].title}${steps[0].unblocks ? ` (unblocks ${steps[0].unblocks})` : ''} → role-router do 1${steps.length > 1 ? ` · ${steps.length - 1} more` : ''}`;
  const lines = ['NEXT  (ranked by what each step unblocks)'];
  steps.slice(0, max).forEach((s, i) => {
    lines.push(` ${String(i + 1).padStart(2)}  ${s.title}${s.unblocks ? `   unblocks ${s.unblocks}` : ''}`);
    if (cmd(s)) lines.push(`       ${cmd(s)}`);
    if (s.note) lines.push(`       ${s.note}`);
  });
  if (blocked.length) lines.push(` ·   blocked: ${blocked.slice(0, 3).join('; ')}${blocked.length > 3 ? '; …' : ''}`);
  lines.push('', ' role-router do <n>            run step n yourself (asks first)', ' role-router do <n> --agent    hand it to the project session');
  return lines.join('\n');
}

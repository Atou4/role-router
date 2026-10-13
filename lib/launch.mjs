// Role Router — run many tasks, across repos, through the full loop at once.
//
// Each task gets its own worktree and runs build → review → docs (lib/next.mjs) under a global
// concurrency cap. Progress is written to ~/.role-router/state/launches/<id>.json so that
// `role-router watch` can show queued and finished tasks, and a detached launch survives the terminal.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearStop, isAlive, stopRequested } from './active.mjs';
import { batchProblems, isBuildable, loadBoard } from './board.mjs';
import { ESCALATION_DEFAULTS, runNext } from './next.mjs';
import { loadConfig } from './config.mjs';
import { gitRoot, requireRepo, resolveRepo } from './repos.mjs';
import { activeProject, scopeRepos } from './scope.mjs';
import { repoRootFor } from './runs.mjs';
import { ensureWorktree } from './worktree.mjs';
import { syncRepo } from './sync.mjs';
import { keepAwake } from './awake.mjs';

export function launchesDir() {
  const base = process.env.ROLE_ROUTER_STATE_DIR || path.join(os.homedir(), '.role-router', 'state');
  return path.join(base, 'launches');
}
const recordPath = (id) => path.join(launchesDir(), `${id}.json`);
const launchStopPath = (id) => path.join(launchesDir(), `${id}.stop`);

/**
 * Turn `TASK-001`, `IncaCook:TASK-101` (or --ready) into concrete targets, refusing anything not
 * buildable right now (unknown, wrong status, open dependencies, also across repos).
 * @returns {Array<{ repoRoot: string, repo: string, id: string }>}
 */
export function resolveTargets(specs, { cwd = process.cwd(), ready = false } = {}) {
  const here = gitRoot(cwd);
  const targets = [];
  if (ready) {
    const roots = new Set([...scopeRepos().map((r) => r.root), ...(here && !activeProject() ? [repoRootFor(here)] : [])]);
    for (const root of roots) {
      try { syncRepo(root); } catch { /* merged-PR reconciliation is best effort */ }
      const board = loadBoard(root);
      for (const t of board?.list ?? []) {
        if (t.status === 'gaps_found' || isBuildable(t, board)) targets.push({ repoRoot: root, repo: path.basename(root), id: t.id });
      }
    }
    return targets;
  }
  if (specs.length === 0) throw new Error('name the tasks to launch (TASK-001, Repo:TASK-101, ...) or use --ready');
  for (const spec of specs) {
    const m = /^([^:\s]+):(\S+)$/.exec(spec);
    let root;
    if (m) {
      root = resolveRepo(m[1], here ? repoRootFor(here) : path.join(cwd, '_'));
      if (!root) throw new Error(`no repo named "${m[1]}" next to this one or among the repos role-router knows`);
    } else {
      root = repoRootFor(requireRepo(cwd, 'launch'));
    }
    targets.push({ repoRoot: repoRootFor(root), repo: path.basename(repoRootFor(root)), id: m ? m[2] : spec });
  }
  const problems = [];
  for (const root of new Set(targets.map((t) => t.repoRoot))) {
    const ids = targets.filter((t) => t.repoRoot === root).map((t) => t.id);
    // Unlike fanout, launch runs the whole loop, so it can also pick a task up at review or docs.
    for (const [id, why] of batchProblems(loadBoard(root), ids, { allow: ['planned', 'gaps_found', 'review', 'passed'] })) problems.push(`${path.basename(root)}:${id}: ${why}`);
  }
  if (problems.length) throw new Error(`not launchable right now:\n  ${problems.join('\n  ')}`);
  return targets;
}

export function newLaunchId(now = new Date()) {
  return `L${now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;
}

function save(record) {
  mkdirSync(launchesDir(), { recursive: true });
  const file = recordPath(record.id);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  renameSync(tmp, file);
}

export function readLaunch(id) {
  try { return JSON.parse(readFileSync(recordPath(id), 'utf8')); } catch { return null; }
}

/** Launch records, newest first; `running` is true while its process is alive. */
export function listLaunches() {
  if (!existsSync(launchesDir())) return [];
  return readdirSync(launchesDir()).filter((f) => /^L.*\.json$/.test(f)).sort().reverse()
    .map((f) => readLaunch(f.slice(0, -5))).filter(Boolean)
    .map((r) => ({ ...r, running: r.tasks.some((t) => ['queued', 'running', 'waiting'].includes(t.state)) && isAlive(r.pid) }));
}

/** Stop a whole launch: queued tasks are not started; running ones get a stop request. */
export function stopLaunch(id, requestStopFor) {
  writeFileSync(launchStopPath(id), new Date().toISOString() + '\n');
  const record = readLaunch(id);
  for (const t of record?.tasks ?? []) if (['queued', 'running', 'waiting'].includes(t.state)) requestStopFor(t.repoRoot, t.id);
}

/** Write the queued record for a launch (the detached child picks it up by id). */
export function createLaunch(targets, { id = newLaunchId(), concurrency = 3, base = 'HEAD', detached = false } = {}) {
  const record = {
    id, pid: process.pid, detached, concurrency, base, startedAt: new Date().toISOString(),
    tasks: targets.map((t) => ({ ...t, state: 'queued' })),
  };
  save(record);
  return record;
}

/** The default lane: own worktree, then the full loop on it. */
async function defaultLane(task, base) {
  const wt = ensureWorktree(task.repoRoot, task.id, base);
  return runNext({ root: wt, task: task.id });
}

/**
 * Run a launch record to completion.
 * @param {string} id
 * @param {{ lane?: typeof defaultLane, onUpdate?: (task: object) => void, policy?: object, sleep?: (ms: number) => Promise<void>, now?: () => number }} [opts]
 */
export async function runLaunch(id, { lane = defaultLane, onUpdate = () => {}, policy, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  let configured = {};
  try { configured = loadConfig().escalation ?? {}; } catch { /* no config: defaults */ }
  const rules = { ...ESCALATION_DEFAULTS, ...configured, ...policy };
  const record = readLaunch(id);
  if (!record) throw new Error(`no launch ${id}`);
  keepAwake();
  record.pid = process.pid;
  save(record);
  const update = (t, patch) => { Object.assign(t, patch); save(record); onUpdate(t); };
  let next = 0;
  const worker = async () => {
    while (next < record.tasks.length) {
      const t = record.tasks[next++];
      if (existsSync(launchStopPath(id)) || stopRequested(t.repoRoot, t.id)) {
        update(t, { state: 'stopped', message: 'stopped before it started', endedAt: new Date().toISOString() });
        continue;
      }
      clearStop(t.repoRoot, t.id);
      update(t, { state: 'running', startedAt: new Date().toISOString() });
      try {
        let r = await lane(t, record.base);
        // Every account limited: wait for the earliest reset, then resume from the handoff.
        for (let waits = 0; r.stop === 'waiting' && rules.waitForLimits && r.resumeAt && waits < 12; waits++) {
          const until = new Date(r.resumeAt).getTime() + 30_000;
          update(t, { state: 'waiting', waitingUntil: new Date(until).toISOString(), message: r.message });
          while (now() < until) {
            if (existsSync(launchStopPath(id)) || stopRequested(t.repoRoot, t.id)) break;
            await sleep(Math.min(5000, Math.max(0, until - now())));
          }
          if (existsSync(launchStopPath(id)) || stopRequested(t.repoRoot, t.id)) {
            r = { stop: 'aborted', message: 'stopped by user while waiting for a limit reset' };
            break;
          }
          update(t, { state: 'running', waitingUntil: undefined });
          r = await lane(t, record.base);
        }
        update(t, { state: 'done', stop: r.stop, message: r.message, endedAt: new Date().toISOString() });
      } catch (e) {
        update(t, { state: 'done', stop: 'crashed', message: e.message, endedAt: new Date().toISOString() });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(record.concurrency, record.tasks.length) }, worker));
  return readLaunch(id);
}

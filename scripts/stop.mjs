#!/usr/bin/env node

// role-router stop TASK-001 [Repo:TASK-101 ...]   stop these tasks (running or queued)
// role-router stop --all                          stop every running task and launch
//
// The agent is ended within about a second; its handoff is kept, so `role-router next <task>` or a
// new launch resumes it later. Nothing is retried on another account after a stop.

import path from 'node:path';
import { isAlive, listActive, requestStop } from '../lib/active.mjs';
import { listLaunches, stopLaunch } from '../lib/launch.mjs';
import { gitRoot, knownRepos, resolveRepo } from '../lib/repos.mjs';
import { repoRootFor } from '../lib/runs.mjs';

const args = process.argv.slice(2);
const stopped = [];
const stopTask = (root, id) => {
  requestStop(root, id);
  // A run whose owning process is already gone cannot honour the flag: end its agent directly.
  for (const a of listActive(root).filter((x) => x.task === id && !isAlive(x.ownerPid) && isAlive(x.pid))) {
    try { process.kill(a.pid, 'SIGTERM'); } catch { /* gone */ }
  }
  stopped.push(`${path.basename(root)}:${id}`);
};

try {
  if (args.includes('--all')) {
    for (const l of listLaunches().filter((x) => x.running)) stopLaunch(l.id, stopTask);
    for (const r of knownRepos()) for (const a of listActive(r.root)) stopTask(r.root, a.task);
  } else {
    if (args.length === 0) throw new Error('usage: role-router stop <TASK|Repo:TASK ...> | --all');
    const here = gitRoot();
    for (const spec of args) {
      const m = /^([^:\s]+):(\S+)$/.exec(spec);
      const root = m ? resolveRepo(m[1], here ? repoRootFor(here) : path.join(process.cwd(), '_')) : here && repoRootFor(here);
      if (!root) throw new Error(`cannot find the repo for ${spec}; use Repo:TASK or run inside the repo`);
      stopTask(root, m ? m[2] : spec);
    }
  }
  console.log(stopped.length ? `Stop requested: ${[...new Set(stopped)].join(', ')}. Handoffs are kept; resume with role-router next <task>.` : 'Nothing running.');
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}

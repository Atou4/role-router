// Role Router — what is running right now, and stop requests.
//
//   <repo>/.role-router/runs/<task>/active.json   written when an agent starts, removed when it ends
//   <repo>/.role-router/runs/<task>/stop          a stop request, honoured by the running dispatch
//
// `role-router watch` reads the markers of every known repo; `role-router stop` drops the flag.
// A marker whose owning process is gone is stale and reported as such, never trusted.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const runsDir = (repoRoot) => path.join(repoRoot, '.role-router', 'runs');
const markerPath = (repoRoot, task) => path.join(runsDir(repoRoot), task, 'active.json');
const stopPath = (repoRoot, task) => path.join(runsDir(repoRoot), task, 'stop');

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Record a running agent. Returns a function that removes the marker.
 * @param {{ pid: number, profile: string, account: string, operation: string, eventsPath?: string, cwd: string }} info
 */
export function markActive(repoRoot, task, info) {
  const file = markerPath(repoRoot, task);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...info, task, repoRoot, ownerPid: process.pid, startedAt: new Date().toISOString() }, null, 2) + '\n');
  return () => { try { rmSync(file); } catch { /* already gone */ } };
}

/** Running agents in one repo; `stale` marks those whose owner process died. */
export function listActive(repoRoot) {
  const dir = runsDir(repoRoot);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const task of readdirSync(dir)) {
    const file = markerPath(repoRoot, task);
    if (!existsSync(file)) continue;
    try {
      const m = JSON.parse(readFileSync(file, 'utf8'));
      const ownerAlive = isAlive(m.ownerPid);
      const agentAlive = isAlive(m.pid);
      // Both gone (e.g. Ctrl+C killed the run before it could clean up): nothing is running, forget it.
      if (!ownerAlive && !agentAlive) { try { rmSync(file); } catch { /* raced */ } continue; }
      out.push({ ...m, stale: !ownerAlive || !agentAlive });
    } catch { /* being written */ }
  }
  return out;
}

export function requestStop(repoRoot, task) {
  mkdirSync(path.dirname(stopPath(repoRoot, task)), { recursive: true });
  writeFileSync(stopPath(repoRoot, task), new Date().toISOString() + '\n');
}
export const stopRequested = (repoRoot, task) => existsSync(stopPath(repoRoot, task));
export function clearStop(repoRoot, task) {
  try { rmSync(stopPath(repoRoot, task)); } catch { /* none */ }
}

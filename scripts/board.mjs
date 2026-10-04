#!/usr/bin/env node

// Role Router — PLAN.md task driver CLI (logic lives in lib/board.mjs).
//
//   role-router board next                 -> JSON of the next buildable task, or NONE
//   role-router board wave                 -> JSON array of buildable tasks (deps done)
//   role-router board list                 -> human summary
//   role-router board status <id>          -> prints the task's status
//   role-router board set-status <id> <s>  -> rewrites the task's status line
//
// Status contract (docs/task-spec.md): planned -> building -> review ->
// {passed | gaps_found | human_needed} -> done. "buildable" = planned with every dependency done.

import { execFileSync } from 'node:child_process';
import { STATUSES, isBuildable, loadBoard, planPath, setStatus } from '../lib/board.mjs';

function repoRoot() {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); }
  catch { return process.cwd(); }
}
const ROOT = repoRoot();
const fail = (msg) => { console.error(msg); process.exit(1); };
const board = () => loadBoard(ROOT) ?? fail(`No PLAN.md at ${planPath(ROOT)}. Run the Architect role first.`);

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'next': {
    const { list, byId } = board();
    const t = list.find((x) => isBuildable(x, byId));
    console.log(t ? JSON.stringify({ id: t.id, title: t.title, depends: t.depends, branch: `task/${t.id}` }, null, 2) : 'NONE');
    break;
  }
  case 'wave': {
    const { list, byId } = board();
    console.log(JSON.stringify(list.filter((t) => isBuildable(t, byId)).map((t) => ({ id: t.id, title: t.title, depends: t.depends })), null, 2));
    break;
  }
  case 'list': {
    const { list, byId } = board();
    for (const t of list) {
      console.log(`${isBuildable(t, byId) ? 'BUILDABLE' : '         '}  ${t.id}  ${t.status.padEnd(12)}  depends=${t.depends.join(',') || '-'}  ${t.title}`);
    }
    break;
  }
  case 'status': {
    const t = board().byId.get(rest[0]);
    if (!t) fail(`Unknown task "${rest[0]}".`);
    console.log(t.status);
    break;
  }
  case 'set-status': {
    try { setStatus(ROOT, rest[0], rest[1]); } catch (e) { fail(e.message); }
    console.log(`${rest[0]} -> ${rest[1]}`);
    break;
  }
  default:
    console.log('Usage: role-router board <next|wave|list|status <id>|set-status <id> <status>>');
    process.exit(cmd ? 1 : 0);
}

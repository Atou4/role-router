#!/usr/bin/env node

// Role Router — task board CLI over PLAN.md and quick tasks (logic lives in lib/board.mjs).
//
//   role-router board next                 -> JSON of the next buildable task, or NONE
//   role-router board wave                 -> JSON array of buildable tasks (deps done)
//   role-router board list                 -> human summary
//   role-router board status <id>          -> prints the task's status
//   role-router board set-status <id> <s>  -> rewrites the task's status line
//
// Status contract (docs/task-spec.md): planned -> building -> review ->
// {passed | gaps_found | human_needed} -> done. "buildable" = planned with every dependency done.
// `done` is never an agent's to set (ROLE_ROUTER_AGENT is in every agent's environment).

import { STATUSES, isBuildable, loadBoard, planPath, setStatus } from '../lib/board.mjs';

import { requireRepo } from '../lib/repos.mjs';

const fail = (msg) => { console.error(msg); process.exit(1); };
let ROOT;
try { ROOT = requireRepo(process.cwd(), `board ${process.argv[2] ?? 'list'}`); } catch (e) { fail(`role-router: ${e.message}`); }
const board = () => loadBoard(ROOT) ?? fail(`No tasks: no PLAN.md at ${planPath(ROOT)} and no quick tasks. Run the Architect role, or role-router fix|quick.`);

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'next': {
    const b = board();
    const t = b.list.find((x) => isBuildable(x, b));
    console.log(t ? JSON.stringify({ id: t.id, title: t.title, depends: t.depends, branch: `task/${t.id}` }, null, 2) : 'NONE');
    break;
  }
  case 'wave': {
    const b = board();
    console.log(JSON.stringify(b.list.filter((t) => isBuildable(t, b)).map((t) => ({ id: t.id, title: t.title, depends: t.depends })), null, 2));
    break;
  }
  case 'list': {
    const b = board();
    for (const t of b.list) {
      console.log(`${isBuildable(t, b) ? 'BUILDABLE' : '         '}  ${t.id}  ${t.status.padEnd(12)}  depends=${t.depends.join(',') || '-'}  ${t.title}`);
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
    // Seen live: a headless Architect marked an unmerged task done, and its dependents started on it.
    if (rest[1] === 'done' && process.env.ROLE_ROUTER_AGENT) {
      fail(`role-router: an agent cannot mark ${rest[0]} done. A task is done only after its PR is merged (role-router sync records it) or a human accepts it; leave it at its current status and say what is left.`);
    }
    try { setStatus(ROOT, rest[0], rest[1]); } catch (e) { fail(e.message); }
    console.log(`${rest[0]} -> ${rest[1]}`);
    break;
  }
  default:
    console.log('Usage: role-router board <next|wave|list|status <id>|set-status <id> <status>>');
    process.exit(cmd ? 1 : 0);
}

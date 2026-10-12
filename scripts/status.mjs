#!/usr/bin/env node

// role-router status          accounts, this repo's board and recent runs
// role-router status --all    accounts and a one-line board summary for every repo role-router knows
//                             (also what you get when you run it outside a repo)

import { accountStates } from '../lib/accounts.mjs';
import { isBuildable, loadBoard } from '../lib/board.mjs';
import { loadConfig } from '../lib/config.mjs';
import { gitRoot, knownRepos, registerRepo } from '../lib/repos.mjs';
import { repoRootFor, listRuns } from '../lib/runs.mjs';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const here = gitRoot(process.cwd());
const all = process.argv.includes('--all') || !here;
const root = here ? repoRootFor(here) : null;
if (root) registerRepo(root);

try {
  const config = loadConfig();
  console.log('Accounts');
  for (const s of accountStates(config)) {
    console.log(`  ${s.account.padEnd(24)} ${s.pausedUntil ? `paused until ${s.pausedUntil.toLocaleString()} (${s.reason}, seen on ${s.seenOn})` : 'ok'}`);
  }
  for (const [role, policy] of Object.entries(config.roles)) console.log(dim(`  ${role}: ${policy.chain.join(' → ')}`));
} catch (error) {
  console.log(`Accounts: ${error.message}`);
}

if (all) {
  console.log('\nRepos');
  const repos = knownRepos();
  if (!repos.length) console.log('  none yet: role-router remembers a repo the first time you run it there');
  for (const r of repos) {
    const b = loadBoard(r.root);
    if (!b) { console.log(`  ${r.name.padEnd(22)} ${dim('no tasks')}  ${dim(r.root)}`); continue; }
    const count = (st) => b.list.filter((t) => t.status === st).length;
    const ready = b.list.filter((t) => isBuildable(t, b)).map((t) => t.id);
    const parts = ['planned', 'building', 'review', 'passed', 'gaps_found', 'human_needed', 'done'].map((st) => (count(st) ? `${count(st)} ${st}` : null)).filter(Boolean);
    console.log(`  ${r.name.padEnd(22)} ${parts.join(' · ')}${ready.length ? `  →  buildable: ${ready.join(', ')}` : ''}\n  ${' '.repeat(22)} ${dim(`role-router -C ${r.root} next`)}`);
  }
  process.exit(0);
}

const board = loadBoard(root);
const runs = new Map(listRuns(root).map((r) => [r.task, r]));
console.log('\nBoard');
if (!board) console.log('  no tasks (no PLAN.md, no quick tasks)');
for (const t of board?.list ?? []) {
  const last = runs.get(t.id)?.runs.at(-1);
  const where = last ? `${last.role}:${last.profile}:${last.kind}${last.evidence?.commit ? ` @${last.evidence.commit}` : ''}` : '';
  console.log(`  ${isBuildable(t, board) ? 'BUILDABLE' : '         '} ${t.id.padEnd(10)} ${t.status.padEnd(12)} ${runs.get(t.id)?.handoff ? 'HANDOFF ' : '        '}${dim(where)}`);
}

const adhoc = [...runs.values()].filter((r) => !board?.byId.has(r.task));
if (adhoc.length) {
  console.log('\nOther runs');
  for (const r of adhoc.slice(-5)) console.log(`  ${r.task}  ${r.runs.map((x) => `${x.profile}:${x.kind}`).join(' → ')}`);
}

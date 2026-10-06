#!/usr/bin/env node

// role-router status — accounts, board and recent runs in one screen.

import { execFileSync } from 'node:child_process';
import { accountStates } from '../lib/accounts.mjs';
import { isBuildable, loadBoard } from '../lib/board.mjs';
import { loadConfig } from '../lib/config.mjs';
import { repoRootFor, listRuns } from '../lib/runs.mjs';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const root = repoRootFor(process.cwd());

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

const board = loadBoard(root);
const runs = new Map(listRuns(root).map((r) => [r.task, r]));
console.log('\nBoard');
if (!board) console.log('  no tasks (no PLAN.md, no quick tasks)');
for (const t of board?.list ?? []) {
  const last = runs.get(t.id)?.runs.at(-1);
  const where = last ? `${last.role}:${last.profile}:${last.kind}${last.evidence?.commit ? ` @${last.evidence.commit}` : ''}` : '';
  console.log(`  ${isBuildable(t, board.byId) ? 'BUILDABLE' : '         '} ${t.id.padEnd(10)} ${t.status.padEnd(12)} ${runs.get(t.id)?.handoff ? 'HANDOFF ' : '        '}${dim(where)}`);
}

const adhoc = [...runs.values()].filter((r) => !board?.byId.has(r.task));
if (adhoc.length) {
  console.log('\nOther runs');
  for (const r of adhoc.slice(-5)) console.log(`  ${r.task}  ${r.runs.map((x) => `${x.profile}:${x.kind}`).join(' → ')}`);
}

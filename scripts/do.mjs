#!/usr/bin/env node

// role-router do <n> [--agent] [--yes]
//
// Runs step n of the NEXT panel (what watch, status and inbox show). With --agent the step is
// handed to the project session instead: routine steps (pr, sync, launch) are acted on; decisions
// and merges are only prepared, the agent recommends and you confirm.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { suggestions } from '../lib/nextsteps.mjs';
import { scopeRepos } from '../lib/scope.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'role-router');
const args = process.argv.slice(2);
const n = Number(args.find((a) => /^\d+$/.test(a)));
try {
  if (!n) throw new Error('usage: role-router do <n> [--agent] [--yes]   (n from the NEXT panel in watch, status or inbox)');
  const { steps } = suggestions(scopeRepos());
  const s = steps[n - 1];
  if (!s) throw new Error(`there is no step ${n}; ${steps.length} step(s) right now`);
  let argv;
  if (args.includes('--agent')) {
    if (!s.project) throw new Error(`${path.basename(s.repoRoot)} is in no project; run the step yourself, or: role-router project create <name> --repos ${path.basename(s.repoRoot)}`);
    argv = ['project', 'ask', s.project, ...(s.act ? ['--act'] : []), s.agent];
  } else {
    if (!s.argv.length) throw new Error(`step ${n} is yours to do: ${s.title}${s.note ? `\n  ${s.note}` : ''}`);
    argv = [...(s.cwd ? ['-C', s.cwd] : []), ...s.argv];
  }
  console.log(`${s.title}\n  role-router ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  if (!args.includes('--yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^y/i.test(await rl.question('Run it? [y/N] '));
    rl.close();
    if (!ok) { console.log('Not run.'); process.exit(0); }
  }
  const r = spawnSync(CLI, argv, { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}

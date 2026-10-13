#!/usr/bin/env node

// role-router pr <[Repo:]TASK ...> [--base BRANCH] [--draft] [--dry-run]
//
// For each passed task: commit what the docs step left uncommitted, push its branch, and open the
// PR into the branch it was cut from, with the docs step's PR body. Prints the PR URL.

import path from 'node:path';
import { loadBoard } from '../lib/board.mjs';
import { openPr } from '../lib/pr.mjs';
import { gitRoot, resolveRepo } from '../lib/repos.mjs';
import { repoRootFor } from '../lib/runs.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3); };
const specs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--base');
let failed = 0;
try {
  if (!specs.length) throw new Error('usage: role-router pr <[Repo:]TASK ...> [--base BRANCH] [--draft] [--dry-run]');
  const here = gitRoot();
  for (const spec of specs) {
    const m = /^([^:\s]+):(\S+)$/.exec(spec);
    const root = m ? resolveRepo(m[1], here ? repoRootFor(here) : path.join(process.cwd(), '_')) : here && repoRootFor(here);
    if (!root) { console.error(`✗ ${spec}: cannot find its repo; use Repo:TASK or run inside the repo`); failed++; continue; }
    const id = m ? m[2] : spec;
    const task = loadBoard(root)?.byId.get(id);
    if (!task) { console.error(`✗ ${spec}: unknown task`); failed++; continue; }
    if (task.status !== 'passed' && !args.includes('--force')) { console.error(`✗ ${spec}: status is ${task.status}, not passed (--force to open it anyway)`); failed++; continue; }
    try {
      const r = openPr(root, task, { base: opt('base'), draft: args.includes('--draft'), run: !args.includes('--dry-run') });
      if (args.includes('--dry-run')) {
        console.log(`${spec}: ${r.branch} → ${r.base}${r.leftovers.length ? `  (would commit: ${r.leftovers.join(', ')})` : ''}`);
        for (const s of r.steps) console.log(`    ${s.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}`);
      } else {
        console.log(`✓ ${spec}: ${r.branch} → ${r.base}${r.leftovers.length ? ` (committed ${r.leftovers.join(', ')})` : ''}  ${r.url ?? ''}`);
      }
    } catch (e) { console.error(`✗ ${spec}: ${e.message}`); failed++; }
  }
  if (!args.includes('--dry-run') && specs.length - failed > 0) console.log('After merging: role-router sync --all, then role-router launch --ready --detach');
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}
process.exit(failed ? 1 : 0);

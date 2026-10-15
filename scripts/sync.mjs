#!/usr/bin/env node

// role-router sync          merged task branches in this repo → done (worktrees cleaned up)
// role-router sync --all    the same for every repo role-router knows

import path from 'node:path';
import { gitRoot, requireRepo } from '../lib/repos.mjs';
import { activeProject, scopeRepos } from '../lib/scope.mjs';
import { repoRootFor } from '../lib/runs.mjs';
import { syncRepo } from '../lib/sync.mjs';

try {
  const all = process.argv.includes('--all') || !gitRoot() || Boolean(activeProject());
  const roots = all ? scopeRepos().map((r) => r.root) : [repoRootFor(requireRepo(process.cwd(), 'sync'))];
  let total = 0;
  for (const root of roots) {
    const r = syncRepo(root);
    total += r.done.length + r.rework.length + r.parked.length;
    if (r.done.length || r.kept.length || !all) {
      console.log(`${path.basename(root)}: ${r.done.length ? `done → ${r.done.join(', ')}` : 'nothing newly merged'} (${r.source})${r.kept.length ? `; kept: ${r.kept.join(', ')}` : ''}`);
    }
    if (r.rework.length) console.log(`${path.basename(root)}: PR feedback → rework: ${r.rework.join(', ')}   (role-router launch <task> --detach, or role-router do)`);
    if (r.parked.length) console.log(`${path.basename(root)}: PR feedback after the last fix round → inbox: ${r.parked.join(', ')}`);
  }
  if (all && total === 0) console.log('Nothing newly merged or sent back in any repo.');
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}

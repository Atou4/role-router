#!/usr/bin/env node

// role-router next — one build → review → docs iteration, driven by code (lib/next.mjs).
//
//   role-router next [TASK-001] [--loop]
//
// --loop keeps going while each task passes. Exit codes match `run`: 0 passed/drained,
// 1 failed, 2 needs a human or a choice, 3 aborted, 75 every profile limited (retry later).

import { loadBoard } from '../lib/board.mjs';
import { pick, runNext } from '../lib/next.mjs';
import { repoRootFor } from '../lib/runs.mjs';
import { syncRepo } from '../lib/sync.mjs';
import { ensureWorktree } from '../lib/worktree.mjs';
import { requireRepo } from '../lib/repos.mjs';
import { keepAwake } from '../lib/awake.mjs';

const args = process.argv.slice(2);
const task = args.find((a) => !a.startsWith('--'));
const loop = args.includes('--loop');

const EXIT = { passed: 0, drained: 0, human_needed: 2, gaps_found: 2, needs_choice: 2, aborted: 3, waiting: 75, crashed: 1, stuck: 1 };
let result;
try {
  const root = requireRepo(process.cwd(), 'next');
  const main = repoRootFor(root);
  keepAwake();
  do {
    // Each task runs in its own worktree: the main checkout's branch is never switched.
    try { syncRepo(main); } catch { /* best effort */ }
    const board = loadBoard(main);
    const id = (!loop && task) || (board && pick(board, main));
    result = id
      ? await runNext({ root: ensureWorktree(main, id), task: id, sync: false })
      : await runNext({ root: main, task: undefined, sync: false });
    const path = result.steps.map((s) => `${s.role}:${s.status}${s.profiles.length ? `(${s.profiles.join('→')})` : ''}`).join('  ');
    console.log(`${result.task ?? '-'}  ${path || '(no steps)'}\n  ${result.stop}: ${result.message}`);
  } while (loop && result.stop === 'passed');
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}
process.exit(EXIT[result.stop] ?? 1);

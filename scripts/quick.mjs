#!/usr/bin/env node

// role-router fix "<bug>" | quick "<small change>" — no planning step, same safety net.
//
// Creates a quick task (.role-router/tasks/FIX-001.md or QUICK-001.md, never committed) whose
// spec is your description, then runs the normal loop on it: Builder (lite chain, fallback on
// limits) → review on another vendor → docs. A Builder that finds the work needs a design
// decision stops with human_needed and tells you to /plan it.
//
//   role-router fix "checkout total is wrong when a coupon is applied"
//   role-router quick "add a --json flag to the export command"
//   role-router fix --no-run "..."      only create the task (run it later with role-router next FIX-001)
//
// Exit codes match `next`: 0 passed · 1 failed · 2 needs you · 3 aborted · 75 every profile limited.

import { execFileSync } from 'node:child_process';
import { createQuickTask } from '../lib/board.mjs';
import { runNext } from '../lib/next.mjs';

const [kind, ...rest] = process.argv.slice(2);
const noRun = rest.includes('--no-run');
const request = rest.filter((a) => a !== '--no-run').join(' ');
let root = process.cwd();
try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a git dir */ }

const EXIT = { passed: 0, drained: 0, human_needed: 2, gaps_found: 2, needs_choice: 2, aborted: 3, waiting: 75, crashed: 1, stuck: 1 };
try {
  const task = createQuickTask(root, kind, request);
  console.log(`${task.id} created: ${task.file}`);
  if (noRun) { console.log(`run it with: role-router next ${task.id}`); process.exit(0); }
  const result = await runNext({ root, task: task.id });
  const steps = result.steps.map((s) => `${s.role}:${s.status}${s.profiles.length ? `(${s.profiles.join('→')})` : ''}`).join('  ');
  console.log(`${task.id}  ${steps || '(no steps)'}\n  ${result.stop}: ${result.message}`);
  if (result.stop === 'human_needed') console.log(`  The Builder's reasoning is under Notes in ${task.file}. If it needs design work: role-router run architect "${request}"`);
  process.exit(EXIT[result.stop] ?? 1);
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}

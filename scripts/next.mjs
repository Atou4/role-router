#!/usr/bin/env node

// role-router next — one build → review → docs iteration, driven by code (lib/next.mjs).
//
//   role-router next [TASK-001] [--loop]
//
// --loop keeps going while each task passes. Exit codes match `run`: 0 passed/drained,
// 1 failed, 2 needs a human or a choice, 3 aborted, 75 every profile limited (retry later).

import { execFileSync } from 'node:child_process';
import { runNext } from '../lib/next.mjs';

const args = process.argv.slice(2);
const task = args.find((a) => !a.startsWith('--'));
const loop = args.includes('--loop');
let root = process.cwd();
try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); } catch { /* not a git dir */ }

const EXIT = { passed: 0, drained: 0, human_needed: 2, gaps_found: 2, needs_choice: 2, aborted: 3, waiting: 75, crashed: 1, stuck: 1 };
let result;
try {
  do {
    result = await runNext({ root, task: loop ? undefined : task });
    const path = result.steps.map((s) => `${s.role}:${s.status}${s.profiles.length ? `(${s.profiles.join('→')})` : ''}`).join('  ');
    console.log(`${result.task ?? '-'}  ${path || '(no steps)'}\n  ${result.stop}: ${result.message}`);
  } while (loop && result.stop === 'passed');
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}
process.exit(EXIT[result.stop] ?? 1);

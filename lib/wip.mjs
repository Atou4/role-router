// Role Router — work in progress a run leaves uncommitted, so the next agent continues it.
//
// After every headless run on a task, the uncommitted files in its working directory are recorded
// with a content hash and the run that left them (.role-router/runs/<ID>/wip.json). The next run
// is told which uncommitted changes are this task's own unfinished work (recorded, unchanged since)
// and which are unexplained (never recorded, or edited after the run). Only unexplained changes
// are a reason to stop.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { repoRootFor } from './runs.mjs';

const wipPath = (repoRoot, task) => path.join(repoRootFor(repoRoot), '.role-router', 'runs', task, 'wip.json');

/** Uncommitted files (tracked and untracked) → content hash, or 'deleted'. null outside git. */
export function dirtyFiles(cwd) {
  let raw;
  try { raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
  const entries = raw.split('\0');
  const files = new Map();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    const file = e.slice(3);
    if (/[RC]/.test(code)) i++; // renames carry the old path as the next entry
    if (file.startsWith('.role-router/')) continue;
    const abs = path.join(cwd, file);
    let hash = 'deleted';
    if (existsSync(abs)) { try { hash = execFileSync('git', ['hash-object', '--', file], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { hash = '?'; } }
    files.set(file, { hash, tracked: code !== '??' });
  }
  return files;
}

function readWip(repoRoot, task) {
  try { return JSON.parse(readFileSync(wipPath(repoRoot, task), 'utf8')); } catch { return { files: {} }; }
}

/** After a run: attribute every uncommitted file that is new or changed to this run. */
export function recordWip(repoRoot, task, cwd, run) {
  const now = dirtyFiles(cwd);
  if (!now) return;
  const before = readWip(repoRoot, task);
  const files = {};
  for (const [file, { hash }] of now) {
    const prev = before.cwd === cwd ? before.files[file] : undefined;
    files[file] = prev?.hash === hash ? prev : { hash, run };
  }
  mkdirSync(path.dirname(wipPath(repoRoot, task)), { recursive: true });
  writeFileSync(wipPath(repoRoot, task), JSON.stringify({ cwd, files }, null, 2) + '\n');
}

/** Before a run: which uncommitted changes are this task's own, and which are unexplained. */
export function classifyWip(repoRoot, task, cwd) {
  const now = dirtyFiles(cwd);
  if (!now?.size) return { own: [], unexplained: [] };
  const known = readWip(repoRoot, task);
  const own = [];
  const unexplained = [];
  for (const [file, { hash, tracked }] of now) {
    const rec = known.cwd === cwd ? known.files[file] : undefined;
    if (rec?.hash === hash) own.push({ file, run: rec.run });
    else if (tracked) unexplained.push(file); // untracked files nobody recorded are left alone anyway
  }
  return { own, unexplained };
}

/** The prompt section, or '' when the working tree is clean. */
export function wipPrompt(repoRoot, task, cwd) {
  const { own, unexplained } = classifyWip(repoRoot, task, cwd);
  if (!own.length && !unexplained.length) return '';
  const parts = ['## Uncommitted changes in this working tree'];
  if (own.length) {
    parts.push(`**Work in progress from earlier runs on ${task}** (recorded by role-router, unchanged since): this is the task's own unfinished work, not a dirty tree. Read it, keep what is right, fix what is not, and continue; commit it with your work.\n${own.map((o) => `- ${o.file} (left by run ${o.run})`).join('\n')}`);
  }
  if (unexplained.length) {
    parts.push(`**Unexplained changes** (no role-router run left them, or they were edited since): do not build on them. Stop and report them, as the clean-tree precondition says.\n${unexplained.map((f) => `- ${f}`).join('\n')}`);
  } else {
    parts.push('There are no unexplained changes: the clean-tree precondition is satisfied.');
  }
  return parts.join('\n\n');
}

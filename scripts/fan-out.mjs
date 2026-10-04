#!/usr/bin/env node

// Role Router — parallel Builder fan-out.
//
// Runs ONE fresh-context Builder per task, concurrently, each in its own git
// worktree so parallel builds never clobber each other's branch/checkout.
//
//   node scripts/fan-out.mjs TASK-001 TASK-002 TASK-003
//   node scripts/fan-out.mjs --concurrency=4 --base=origin/main TASK-00{1..6}
//
// Each task goes through dispatch(), so the Builder chain can fall through to another
// agent when an account hits its usage limit; the task's worktree is kept and the next
// agent resumes from .role-router/runs/<id>/handoff.md. Runs that hit a limit on EVERY
// profile are reported as "waiting" with the earliest reset time.
//
// Flags:
//   --concurrency=N   max simultaneous Builders            (default 3)
//   --base=<ref>      branch to cut each task/<id> from     (default HEAD)
//   --no-worktree     build in the current dir (UNSAFE for >1 task)
//   --yes             skip the confirmation prompt
//   --dry-run         validate and print the launch plan only

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { dispatch } from '../lib/dispatch.mjs';
import { loadConfig } from '../lib/config.mjs';
import { repoRootFor } from '../lib/runs.mjs';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const ids = argv.filter((a) => !a.startsWith('--'));
const concurrency = Math.max(1, Number(opt('concurrency', '3')) || 3);
const base = opt('base', 'HEAD');
const useWorktree = !has('no-worktree');
const autoYes = has('yes');
const dryRun = has('dry-run');

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const grn = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const die = (msg) => { console.error(red(msg)); process.exit(1); };

if (ids.length === 0) {
  die('Usage: fan-out.mjs [--concurrency=N] [--base=ref] [--no-worktree] TASK-001 TASK-002 …');
}
if (!useWorktree && ids.length > 1) {
  die('Refusing to run >1 task with --no-worktree: parallel builds in one dir corrupt each other. Drop --no-worktree.');
}

const REPO = repoRootFor(process.cwd());
const WT_ROOT = path.join(REPO, '.role-router', 'worktrees');

// ── one Builder ───────────────────────────────────────────────────────────────
function buildOne(id) {
  return new Promise((resolve) => {
    let cwd = REPO;
    const branch = `task/${id}`;

    if (useWorktree) {
      cwd = path.join(WT_ROOT, id);
      // A task that stopped on a usage limit keeps its worktree; the next agent resumes in it.
      if (existsSync(path.join(cwd, '.git'))) return runBuilder();
      try {
        // Reuse an existing branch if present; else cut a fresh one from base.
        const exists = (() => {
          try { execFileSync('git', ['rev-parse', '--verify', branch], { cwd: REPO, stdio: 'ignore' }); return true; }
          catch { return false; }
        })();
        const addArgs = exists
          ? ['worktree', 'add', cwd, branch]
          : ['worktree', 'add', cwd, '-b', branch, base];
        execFileSync('git', addArgs, { cwd: REPO, stdio: 'pipe' });
      } catch (e) {
        const msg = (e.stderr?.toString() || e.message || '').trim();
        return resolve({ id, ok: false, stage: 'worktree', detail: msg });
      }
    }

    runBuilder();

    function runBuilder() {
    dispatch({ role: 'builder', task: id, message: id, mode: 'headless', cwd, repoRoot: REPO })
      .then((out) => {
        const results = out.runs.map((r) => r.result);
        resolve({
          id, branch, cwd,
          ok: out.status === 'ok',
          stage: out.status === 'ok' ? 'build' : out.status,
          profile: out.profile ?? out.runs.at(-1)?.profile,
          path: out.runs.map((r) => r.profile).join(' → '),
          cost: results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) || undefined,
          turns: results.reduce((sum, r) => sum + (r.turns ?? 0), 0) || undefined,
          detail: detailFor(out),
        });
      })
      .catch((e) => resolve({ id, ok: false, stage: 'dispatch', detail: e.message, cwd, branch }));
    }
  });
}

function detailFor(out) {
  if (out.status === 'ok') return '';
  if (out.status === 'waiting') return `all profiles limited; earliest reset ${out.resumeAt.toLocaleString()}; handoff ${out.handoff ?? 'none'}`;
  if (out.status === 'needs_choice') return `needs a decision: ${out.choice.question}`;
  return out.message ?? out.status;
}

// ── concurrency pool ──────────────────────────────────────────────────────────
async function pool(items, n, worker) {
  const out = [];
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      console.log(dim(`▶ start ${items[i]}  (${i + 1}/${items.length})`));
      out[i] = await worker(items[i]);
      const r = out[i];
      console.log(`${r.ok ? grn('✓') : red('✗')} ${items[i]}  ${dim(r.ok ? `${r.path}${r.turns ? `, ${r.turns} turns` : ''}` : `${r.stage}: ${r.detail}`)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(`Fan-out: ${ids.length} task(s), concurrency ${concurrency}${useWorktree ? ', isolated worktrees' : ', SHARED dir'}.`);
let roleConfig;
try { roleConfig = loadConfig(); } catch (e) { die(e.message); }
if (!roleConfig.roles.builder) die('Builder has no chain in the role config.');
console.log(dim(`Builder chain: ${roleConfig.roles.builder.chain.join(' → ')}.`));

if (dryRun) {
  console.log(JSON.stringify({ ids, concurrency, base, useWorktree }, null, 2));
  process.exit(0);
}

if (!autoYes) {
  process.stdout.write('Each child runs headless (unattended permissions per its adapter) in its own worktree. Continue? [y/N] ');
  const ans = await new Promise((r) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', (a) => { rl.close(); r(a); });
  });
  if (!/^y(es)?$/i.test(ans.trim())) die('Aborted.');
}

const results = await pool(ids, concurrency, buildOne);

// ── summary ────────────────────────────────────────────────────────────────────
console.log('\n── Fan-out summary ─────────────────────────');
let totalCost = 0;
for (const r of results) {
  if (r.cost) totalCost += r.cost;
  const cost = r.cost ? `$${r.cost.toFixed(4)}` : '—';
  console.log(`${r.ok ? grn('✓') : red('✗')} ${r.id.padEnd(10)} ${(r.branch || '').padEnd(16)} ${cost.padStart(9)}  ${r.ok ? dim(r.path) : r.detail}`);
}
console.log(dim(`Total est. cost: $${totalCost.toFixed(4)}  ·  run records in .role-router/runs/<task>/  ·  worktrees in .role-router/worktrees/`));
const failed = results.filter((r) => !r.ok);
console.log('\nNext: review each branch, then `/review`+`/docs` (or open PRs).');
if (useWorktree) console.log(dim('Remove a finished worktree with: git worktree remove .role-router/worktrees/<id>'));
if (failed.length) { console.log(red(`${failed.length} task(s) failed — inspect .role-router/runs/<task>/ (records, logs, handoff.md) before retrying.`)); process.exit(2); }

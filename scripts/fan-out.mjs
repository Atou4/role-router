#!/usr/bin/env node

// Role Router — parallel Builder fan-out.
//
// Runs ONE fresh-context Builder per task, concurrently, each in its own git
// worktree so parallel builds never clobber each other's branch/checkout.
//
//   node scripts/fan-out.mjs TASK-001 TASK-002 TASK-003
//   node scripts/fan-out.mjs --concurrency=4 --base=origin/main TASK-00{1..6}
//
// Each task is launched through run-role.mjs, so its Builder binding may be
// Codex CLI, Claude Code, or OpenCode without changing the scheduler.
//
// Flags:
//   --concurrency=N   max simultaneous Builders            (default 3)
//   --base=<ref>      branch to cut each task/<id> from     (default HEAD)
//   --no-worktree     build in the current dir (UNSAFE for >1 task)
//   --yes             skip the confirmation prompt
//   --dry-run         validate and print the launch plan only

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_ROLE = path.join(SCRIPT_DIR, 'run-role.mjs');
const WT_ROOT = path.join(REPO, '.role-router', 'worktrees');
const LOG_ROOT = path.join(REPO, '.role-router', 'runs');
mkdirSync(LOG_ROOT, { recursive: true });

// ── one Builder ───────────────────────────────────────────────────────────────
function buildOne(id) {
  return new Promise((resolve) => {
    let cwd = REPO;
    const branch = `task/${id}`;

    if (useWorktree) {
      cwd = path.join(WT_ROOT, id);
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

    const logPath = path.join(LOG_ROOT, `${id}.jsonl`);
    const logFile = createWriteStream(logPath);
    const child = spawn(process.execPath, [RUN_ROLE, 'builder', id, '--headless', `--cwd=${cwd}`], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let result = null;
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      logFile.write(line + '\n');
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'result') result = ev;
      } catch { /* non-JSON progress line */ }
    });
    child.stderr.on('data', (d) => logFile.write(d));

    child.on('error', (e) => resolve({ id, ok: false, stage: 'spawn', detail: e.message, cwd, branch, logPath }));
    child.on('close', (code) => {
      logFile.end();
      resolve({
        id, branch, cwd, logPath,
        ok: code === 0,
        stage: 'build',
        cost: result?.total_cost_usd,
        tokens: (result?.usage?.input_tokens ?? 0) + (result?.usage?.output_tokens ?? 0),
        turns: result?.num_turns,
        detail: code === 0 ? '' : `exit ${code}`,
      });
    });
  });
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
      console.log(`${r.ok ? grn('✓') : red('✗')} ${items[i]}  ${dim(r.ok ? `${r.turns ?? '?'} turns` : `${r.stage}: ${r.detail}`)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(`Fan-out: ${ids.length} task(s), concurrency ${concurrency}${useWorktree ? ', isolated worktrees' : ', SHARED dir'}.`);
if (!existsSync(RUN_ROLE)) die(`Role adapter not found at ${RUN_ROLE}. Re-run install.sh.`);
const roleConfigPath = process.env.ROLE_ROUTER_CONFIG || path.join(os.homedir(), '.role-router', 'config.json');
if (!existsSync(roleConfigPath)) die(`Role config not found at ${roleConfigPath}. Run role-router configure.`);
const roleConfig = JSON.parse(readFileSync(roleConfigPath, 'utf8'));
const adapter = roleConfig.roles?.builder?.adapter;
if (!adapter || adapter === 'unconfigured') die(`Builder has no configured adapter in ${roleConfigPath}.`);
console.log(dim(`Builder adapter: ${adapter}${roleConfig.roles.builder.model ? ` (${roleConfig.roles.builder.model})` : ''}.`));

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
  console.log(`${r.ok ? grn('✓') : red('✗')} ${r.id.padEnd(10)} ${(r.branch || '').padEnd(16)} ${cost.padStart(9)}  ${r.ok ? '' : r.detail}`);
}
console.log(dim(`Total est. cost: $${totalCost.toFixed(4)}  ·  logs in .role-router/runs/  ·  worktrees in .role-router/worktrees/`));
const failed = results.filter((r) => !r.ok);
console.log('\nNext: review each branch, then `/review`+`/docs` (or open PRs).');
if (useWorktree) console.log(dim('Remove a finished worktree with: git worktree remove .role-router/worktrees/<id>'));
if (failed.length) { console.log(red(`${failed.length} task(s) failed — inspect their .jsonl log before retrying.`)); process.exit(2); }

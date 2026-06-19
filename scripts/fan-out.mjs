#!/usr/bin/env node

// Role Router — parallel Builder fan-out.
//
// Runs ONE fresh-context Builder per task, concurrently, each in its own git
// worktree so parallel builds never clobber each other's branch/checkout.
//
//   node scripts/fan-out.mjs TASK-001 TASK-002 TASK-003
//   node scripts/fan-out.mjs --concurrency=4 --base=origin/main TASK-00{1..6}
//
// Mechanism (adapted from gruckion/nested-subagent): each task is a separate
// headless `claude -p "/build <id>"` OS process — a brand-new main agent with a
// fresh context window and full tool access. The plugin spawns those children on
// the VANILLA harness (your Max quota / paid API). We don't: by default we point
// each child at the local CCR proxy via ANTHROPIC_BASE_URL, so every parallel
// Builder runs on the cheap Engine (ADR-0001/0002). That is the whole reason this
// exists instead of just installing the plugin.
//
// Flags:
//   --concurrency=N   max simultaneous Builders            (default 3)
//   --base=<ref>      branch to cut each task/<id> from     (default origin/dev)
//   --engine=ccr|vanilla   route children via CCR or Max    (default ccr)
//   --no-worktree     build in the current dir (UNSAFE for >1 task)
//   --prompt=<tmpl>   child prompt; {id} is substituted     (default "/build {id}")
//   --yes             skip the confirmation prompt
//
// Env:
//   ROLE_ROUTER_CCR_URL   CCR proxy base URL   (default http://127.0.0.1:3456)
//   ROLE_ROUTER_CCR_KEY   key CCR expects      (default "ccr")

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { request } from 'node:http';
import path from 'node:path';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const ids = argv.filter((a) => !a.startsWith('--'));
const concurrency = Math.max(1, Number(opt('concurrency', '3')) || 3);
const base = opt('base', 'origin/dev');
const engine = opt('engine', 'ccr');
const useWorktree = !has('no-worktree');
const promptTmpl = opt('prompt', '/build {id}');
const autoYes = has('yes');

const CCR_URL = process.env.ROLE_ROUTER_CCR_URL || 'http://127.0.0.1:3456';
const CCR_KEY = process.env.ROLE_ROUTER_CCR_KEY || 'ccr';

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const grn = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const die = (msg) => { console.error(red(msg)); process.exit(1); };

if (ids.length === 0) {
  die('Usage: fan-out.mjs [--concurrency=N] [--base=ref] [--engine=ccr|vanilla] [--no-worktree] TASK-001 TASK-002 …');
}
if (!useWorktree && ids.length > 1) {
  die('Refusing to run >1 task with --no-worktree: parallel builds in one dir corrupt each other. Drop --no-worktree.');
}

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const WT_ROOT = path.join(REPO, '.role-router', 'worktrees');
const LOG_ROOT = path.join(REPO, '.role-router', 'runs');
mkdirSync(LOG_ROOT, { recursive: true });

// ── child environment ───────────────────────────────────────────────────────
function childEnv() {
  if (engine === 'vanilla') return process.env; // Max quota / paid API — caller's choice
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: CCR_URL,
    ANTHROPIC_API_KEY: CCR_KEY,
    ANTHROPIC_AUTH_TOKEN: CCR_KEY,
  };
}

// ── CCR preflight ─────────────────────────────────────────────────────────────
function ccrReachable() {
  return new Promise((resolve) => {
    const u = new URL(CCR_URL);
    const req = request(
      { hostname: u.hostname, port: u.port || 80, path: '/', method: 'GET', timeout: 1500 },
      (res) => { res.resume(); resolve(true); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

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
    const prompt = promptTmpl.replaceAll('{id}', id);

    const child = spawn('claude', [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions', // headless: gates run unattended (build is on its own branch/worktree)
      '--add-dir', REPO,
    ], { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

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
console.log(`Fan-out: ${ids.length} task(s), concurrency ${concurrency}, engine ${engine}${useWorktree ? ', isolated worktrees' : ', SHARED dir'}.`);
if (engine === 'ccr') {
  if (!(await ccrReachable())) {
    die(`CCR proxy not reachable at ${CCR_URL}. Start it with \`ccr start\` (or set ROLE_ROUTER_CCR_URL). To deliberately use Max quota instead: --engine=vanilla.`);
  }
  console.log(dim(`CCR proxy ok at ${CCR_URL} → children route to the cheap Engine.`));
} else {
  console.log(red('engine=vanilla: children run on your Max quota / paid API.'));
}

if (!autoYes) {
  process.stdout.write('Each child runs --dangerously-skip-permissions in its own worktree. Continue? [y/N] ');
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

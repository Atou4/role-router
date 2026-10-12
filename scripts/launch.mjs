#!/usr/bin/env node

// role-router launch — many tasks, across repos, through the full loop at once.
//
//   role-router launch TASK-001 TASK-011                      tasks in this repo
//   role-router launch IncaCook-Server:TASK-001 IncaCook:TASK-101
//   role-router launch --ready                                 every buildable task in every known repo
//   ... --detach            keep running after the terminal closes (log in ~/.role-router/state/launches/)
//   ... --concurrency=N     tasks at once (default 3)      --base=REF   branch new worktrees start from
//   ... --yes               skip the confirmation
//
// Each task gets its own worktree and runs build → review (other vendor) → docs. Watch with
// `role-router watch`; stop with `role-router stop <task>` or `role-router stop --all`.

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createLaunch, launchesDir, readLaunch, resolveTargets, runLaunch } from '../lib/launch.mjs';

const args = process.argv.slice(2);
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const has = (n) => args.includes(`--${n}`);

function line(t) {
  const label = `${t.repo}:${t.id}`;
  if (t.state === 'running') return `▶ ${label}`;
  if (t.state === 'stopped') return `■ ${label}  ${t.message}`;
  return `${t.stop === 'passed' ? '✓' : '✗'} ${label}  ${t.stop}: ${(t.message ?? '').split('\n')[0]}`;
}

try {
  // Detached child: run an existing record.
  const runId = opt('run');
  if (runId) {
    const done = await runLaunch(runId, { onUpdate: (t) => console.log(`${new Date().toISOString()} ${line(t)}`) });
    console.log(`${new Date().toISOString()} launch ${runId} finished: ${done.tasks.filter((t) => t.stop === 'passed').length}/${done.tasks.length} passed`);
    process.exit(0);
  }

  const targets = resolveTargets(args.filter((a) => !a.startsWith('--')), { ready: has('ready') });
  if (targets.length === 0) { console.log('Nothing buildable right now. role-router status --all shows why.'); process.exit(0); }
  const concurrency = Math.max(1, Number(opt('concurrency') ?? 3) || 3);
  console.log(`Launching ${targets.length} task(s), ${concurrency} at a time, each in its own worktree (build → review → docs):`);
  for (const t of targets) console.log(`  ${t.repo}:${t.id}`);
  if (!has('yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^y/i.test(await rl.question('Agents run unattended with their headless permissions. Continue? [y/N] '));
    rl.close();
    if (!ok) { console.log('Aborted.'); process.exit(1); }
  }

  const record = createLaunch(targets, { concurrency, base: opt('base') ?? 'HEAD', detached: has('detach') });
  if (has('detach')) {
    const log = path.join(launchesDir(), `${record.id}.log`);
    const fd = openSync(log, 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--run=${record.id}`], { detached: true, stdio: ['ignore', fd, fd], env: process.env, cwd: process.cwd() });
    child.unref();
    console.log(`\nLaunch ${record.id} running in the background (pid ${child.pid}).\n  watch: role-router watch\n  log:   ${log}\n  stop:  role-router stop --all`);
    process.exit(0);
  }
  const done = await runLaunch(record.id, { onUpdate: (t) => console.log(line(t)) });
  const passed = done.tasks.filter((t) => t.stop === 'passed').length;
  console.log(`\n${passed}/${done.tasks.length} passed. Merge the PRs; role-router status --all shows the boards.`);
  process.exit(passed === done.tasks.length ? 0 : 2);
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}

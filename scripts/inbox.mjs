#!/usr/bin/env node

// role-router inbox                       open escalations in every repo role-router knows
// role-router resolve <Repo:TASK | #n> --option <n> | --note "<decision>" [--repos A,B] [--no-run]
//
// resolve records your decision (every later prompt for that task gets it) and routes it:
//   design       a headless Architect applies it to the affected specs (also in other repos),
//                then the task is relaunched
//   others       the task goes back to the Builder with your decision, and is relaunched
// --no-run only records the decision.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoard, setStatus } from '../lib/board.mjs';
import { dispatch } from '../lib/dispatch.mjs';
import { backfill, decisionPrompt, escalationPath, listEscalations, recordDecision } from '../lib/escalations.mjs';
import { gitRoot, knownRepos, registerRepo, resolveRepo } from '../lib/repos.mjs';
import { appendDecision, projectsFor, scopeRepos } from '../lib/scope.mjs';
import { renderNext, suggestions } from '../lib/nextsteps.mjs';
import { resumeStatus } from '../lib/next.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { repoRootFor } from '../lib/runs.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'role-router');
const [cmd, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf(`--${n}`); return i !== -1 ? rest[i + 1] : rest.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3); };
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function show(list) {
  if (!list.length) { console.log('Inbox empty: nothing is waiting on you.'); return; }
  list.forEach((e, i) => {
    console.log(`${String(i + 1).padStart(2)}  ${e.repo}:${e.task}  [${e.type}]  ${e.question}`);
    e.options.forEach((o, k) => console.log(`      ${k + 1}. ${o}`));
    if (e.recommendation) console.log(`      recommends: ${e.recommendation}`);
    if (e.blocks.length) console.log(dim(`      blocks: ${e.blocks.join(', ')}`));
    console.log(dim(`      details: ${escalationPath(e.repoRoot, e.task)}`));
    console.log(dim(`      role-router resolve ${e.repo}:${e.task} ${e.options.length ? '--option <n>' : '--note "<your decision>"'}`));
  });
}

function target(spec, list) {
  const n = /^#?(\d+)$/.exec(spec ?? '');
  if (n) { const e = list[Number(n[1]) - 1]; if (!e) throw new Error(`no inbox item #${n[1]}`); return e; }
  const m = /^([^:\s]+):(\S+)$/.exec(spec ?? '');
  const here = gitRoot();
  const root = m ? resolveRepo(m[1], here ? repoRootFor(here) : path.join(process.cwd(), '_')) : here && repoRootFor(here);
  const id = m ? m[2] : spec;
  const e = list.find((x) => x.repoRoot === (root && repoRootFor(root)) && x.task === id);
  if (!e) throw new Error(`no open escalation for ${spec}; role-router inbox lists them`);
  return e;
}

try {
  const here = gitRoot();
  if (here) registerRepo(repoRootFor(here)); // using inbox/resolve inside a repo counts as using it there
  const scope = scopeRepos().map((r) => r.root);
  if (here) scope.push(repoRootFor(here));
  backfill(scope);
  const list = listEscalations(scope);
  if (cmd !== 'resolve') {
    show(list);
    try { console.log(`\n${renderNext(suggestions(scopeRepos()))}`); } catch { /* best effort */ }
    process.exit(0);
  }

  const e = target(rest.find((a) => !a.startsWith('--') && rest[rest.indexOf(a) - 1] !== '--option' && rest[rest.indexOf(a) - 1] !== '--note'), list);
  const option = opt('option') !== undefined ? Number(opt('option')) : undefined;
  const decision = recordDecision(e.repoRoot, e.task, { option, note: opt('note') });
  console.log(`Decision recorded for ${e.repo}:${e.task}: ${decision.optionText ?? decision.note}`);
  for (const p of projectsFor(e.repoRoot)) {
    appendDecision(p.name, { decision: `${e.repo}:${e.task}: ${e.question} → ${decision.optionText ?? decision.note}`, affects: [`${e.repo}:${e.task}`, ...e.affects], source: 'resolve' });
    console.log(`Added to the ${p.name} decision log.`);
  }
  if (rest.includes('--no-run')) process.exit(0);

  // Decided before the Architect's replan run, which adds a run record of its own.
  const resumeAt = resumeStatus(e.repoRoot, e.task, loadBoard(e.repoRoot)?.byId.get(e.task)?.status);
  if (e.type === 'design') {
    // Other repos named in `affects` must be writable for the Architect, and are listed with their paths.
    // Repos the decision may touch: named in `affects`, given with --repos, or mentioned in the escalation.
    const text = readFileSync(escalationPath(e.repoRoot, e.task), 'utf8');
    const names = [
      ...e.affects.map((a) => a.split(':')).filter((p) => p.length === 2).map(([name]) => name),
      ...(opt('repos') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      ...knownRepos().map((r) => r.name).filter((n) => n !== e.repo && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)),
    ];
    const repos = [...new Set(names.map((n) => (existsSync(n) ? path.resolve(n) : resolveRepo(n, e.repoRoot))).filter(Boolean))].filter((r) => r !== e.repoRoot);
    const message = `${e.task}\n\n${decisionPrompt(e.repoRoot, e.task)}\n\nEscalation file: ${escalationPath(e.repoRoot, e.task)}\nAffected tasks: ${e.affects.join(', ') || '(none listed)'}\nRepos: ${[e.repoRoot, ...repos].join(', ')}`;
    console.log('Architect is applying the decision to the affected specs (headless)…');
    const out = await dispatch({ role: 'replan', task: e.task, message, mode: 'headless', cwd: e.repoRoot, addDirs: repos });
    if (out.status !== 'ok') throw new Error(`the Architect could not apply it: ${out.message ?? out.status}`);
  }
  // Resume at the stage that stopped (the replan may have moved the status: it wins unless it left human_needed).
  const now = loadBoard(e.repoRoot)?.byId.get(e.task)?.status;
  const status = e.type === 'design' && now !== 'human_needed' ? now : resumeAt;
  if (status !== now) setStatus(e.repoRoot, e.task, status);
  console.log(`${e.task} resumes at ${status === 'planned' || status === 'gaps_found' ? 'the build' : status === 'passed' ? 'docs' : status}.`);
  const child = spawn(CLI, ['launch', `${e.repo}:${e.task}`, '--yes', '--detach'], { cwd: e.repoRoot, stdio: 'inherit' });
  child.on('close', (code) => process.exit(code ?? 0));
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}

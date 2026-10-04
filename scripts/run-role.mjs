#!/usr/bin/env node

// role-router run|chat — one Role through the dispatcher (see lib/dispatch.mjs).
//
//   role-router run <architect|builder|worker|review|docs|escalation> [argument] [flags]
//   role-router chat <role> <message>        (= run --raw)
//
// Flags: --headless  --dry-run  --raw  --cwd=DIR  --profile=ID (run exactly that profile, no fallback)
// Exit codes: 0 ok · 1 failed · 2 needs a decision · 3 aborted · 75 every profile is limited (retry later)

import path from 'node:path';
import { dispatch } from '../lib/dispatch.mjs';

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const has = (name) => flags.includes(`--${name}`);
const option = (name) => flags.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const [role, ...rest] = argv.filter((a) => !a.startsWith('--'));
const message = rest.join(' ');

const ROLES = ['architect', 'builder', 'worker', 'review', 'docs', 'escalation'];
if (!ROLES.includes(role)) {
  console.error(`usage: role-router run <${ROLES.join('|')}> [argument] [--headless] [--dry-run] [--raw] [--cwd=DIR] [--profile=ID]`);
  process.exit(1);
}

let outcome;
try {
  outcome = await dispatch({
    role,
    message: message || undefined,
    raw: has('raw'),
    mode: has('headless') ? 'headless' : 'interactive',
    cwd: path.resolve(option('cwd') || process.cwd()),
    profile: option('profile'),
    dryRun: has('dry-run'),
  });
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}

if (outcome.plan) {
  console.log(JSON.stringify({ role, chain: outcome.plan }, null, 2));
  process.exit(0);
}

if (outcome.skills?.missing.length) console.error(`role-router: skills not installed for this agent: ${outcome.skills.missing.join(', ')} (see role-router skills doctor)`);
const ran = outcome.runs.map((r) => `${r.profile}:${r.result.kind}`).join(' → ');
if (ran && has('headless')) console.error(`role-router: ${ran}`);
if (outcome.tierDropped) console.error('role-router: ran on a lighter tier than the chain head; re-review the result.');

switch (outcome.status) {
  case 'ok': process.exit(0);
  case 'waiting':
    console.error(`role-router: ${outcome.message}; earliest reset ${outcome.resumeAt.toLocaleString()}. Handoff: ${outcome.handoff ?? '(none)'}`);
    process.exit(75);
  case 'needs_choice':
    console.error(`role-router: ${outcome.choice.question}\n  options: ${outcome.choice.options.join(' | ')}\n  Re-run interactively to choose.`);
    process.exit(2);
  case 'aborted':
    console.error(`role-router: ${outcome.message}${outcome.resumeAt ? `; earliest reset ${outcome.resumeAt.toLocaleString()}` : ''}`);
    process.exit(3);
  default:
    console.error(`role-router: ${outcome.message ?? 'failed'}`);
    process.exit(1);
}

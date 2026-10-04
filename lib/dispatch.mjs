// Role Router — the orchestrator's one entry point.
//
// dispatch() runs a Role on the best usable profile in its chain, falling through on
// usage limits with a handoff, and asking before a planning Role drops to a lighter
// tier. No model participates in these decisions. See docs/design/dispatch.md.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountStates, pauseAccount } from './accounts.mjs';
import { agents as defaultAgents } from './agents/index.mjs';
import { loadConfig } from './config.mjs';
import { archiveHandoff, gitEvidence, handoffPath, hasHandoff, lastAccountFor, repoRootFor, resumableSession, startRun, writeHandoff } from './runs.mjs';

const COMMANDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands');
const ROLE_COMMANDS = { architect: 'plan', builder: 'build', worker: 'review', review: 'review', docs: 'docs', escalation: 'build' };
const TIER_RANK = { lite: 0, top: 1 };
const TASK_ID = /^TASK-\S+$/;

/** @typedef {'architect' | 'builder' | 'worker' | 'review' | 'docs' | 'escalation'} RoleName */

/**
 * @typedef {object} DispatchRequest
 * @property {RoleName} role
 * @property {string} [task]       TASK-id; enables handoff resume and cross-account review
 * @property {string} [message]    free text for the role prompt's $ARGUMENTS (or the raw prompt with `raw`)
 * @property {boolean} [raw]       send `message` as-is instead of the role prompt
 * @property {'interactive' | 'headless'} mode
 * @property {string} cwd
 * @property {string} [repoRoot]   where .role-router/ lives; defaults to the main checkout of cwd
 * @property {string} [profile]    explicit override: run exactly this profile, no fallback
 * @property {boolean} [dryRun]    resolve the chain and describe the launches; spawn nothing
 */

/**
 * @typedef {object} Outcome
 * @property {'ok' | 'crashed' | 'waiting' | 'needs_choice' | 'aborted'} status
 *   ok           an agent finished (Role-level success is read from the board, not here)
 *   crashed      an agent failed for a reason other than limits, or no profile could start
 *   waiting      every profile in the chain is limited; see resumeAt
 *   needs_choice headless run needs a user decision; see choice
 *   aborted      the user chose wait or abort at a prompt
 * @property {string} [profile]
 * @property {boolean} tierDropped
 * @property {Date} [resumeAt]
 * @property {string} [message]
 * @property {{ question: string, options: string[] }} [choice]
 * @property {string} [handoff]
 * @property {Array<{ profile: string, account: string, result: import('./agents/types.mjs').AgentResult, recordPath?: string, resumed?: boolean }>} runs
 * @property {Array<{ profile: string, command: string, args: string[] }>} [plan]  dry runs only
 */

/**
 * Test seams; production callers pass nothing.
 * @typedef {object} Deps
 * @property {Record<string, import('./agents/types.mjs').Agent>} [agents]
 * @property {import('./config.mjs').Config} [config]
 * @property {() => Date} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {(question: string, options: Array<{ key: string, label: string }>) => Promise<string | null>} [ask]
 */

/**
 * @param {DispatchRequest} request
 * @param {Deps} [deps]
 * @returns {Promise<Outcome>}
 */
export async function dispatch(request, deps = {}) {
  const agents = deps.agents ?? defaultAgents;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const ask = deps.ask ?? askOnTty;
  const config = deps.config ?? loadConfig();

  const bindingRole = ['review', 'docs'].includes(request.role) ? 'worker' : request.role;
  const policy = config.roles[bindingRole];
  if (!policy) throw new Error(`role ${bindingRole} has no chain in the config`);

  const repoRoot = request.repoRoot ?? repoRootFor(request.cwd);
  const task = request.task ?? (TASK_ID.test(request.message ?? '') ? request.message : adhocId(now()));
  const builderAccount = bindingRole === 'worker' && policy.avoidBuilderAccount ? lastAccountFor(repoRoot, task, 'builder') : null;
  const chain = request.profile ? [request.profile] : orderChain(config, policy, builderAccount);
  for (const id of chain) if (!config.profiles[id]) throw new Error(`unknown profile "${id}"`);

  const basePrompt = buildPrompt(request, task);
  const headTier = TIER_RANK[config.profiles[chain[0]].tier];

  if (request.dryRun) return describe(config, agents, chain, basePrompt, request);

  /** @type {Outcome} */
  const outcome = { status: 'crashed', tierDropped: false, runs: [] };
  const problems = [];
  let tierConsent = false;
  let sameAccountConsent = false;

  for (const id of chain) {
    const profile = config.profiles[id];
    const account = config.accounts[profile.account];
    const agent = agents[account.agent];

    const paused = accountStates(config, now()).find((s) => s.account === profile.account)?.pausedUntil;
    if (paused) { problems.push({ id, paused }); continue; }
    const problem = agent.preflight(account, profile);
    if (problem) { problems.push({ id, problem }); continue; }

    const ranDown = TIER_RANK[profile.tier] < headTier;
    if (ranDown && policy.onTierDrop === 'ask' && !request.profile && !tierConsent) {
      const resumeAt = earliest(problems.map((p) => p.paused));
      const options = [
        { key: 'w', label: `wait${resumeAt ? ` (earliest reset ${resumeAt.toLocaleTimeString()})` : ''}` },
        { key: 's', label: `switch to ${id}${profile.model ? ` (${profile.model})` : ''}; the result is flagged as lighter-tier` },
        { key: 'a', label: 'abort' },
      ];
      const question = `All ${config.profiles[chain[0]].tier}-tier ${bindingRole} profiles are unavailable (${problems.map((p) => p.id).join(', ') || 'none usable'}).`;
      if (request.mode === 'headless') return { ...outcome, status: 'needs_choice', resumeAt, choice: { question, options: options.map((o) => o.label) } };
      const answer = await ask(question, options);
      if (answer !== 's') return { ...outcome, status: 'aborted', resumeAt, message: answer === 'w' ? 'waiting for a reset' : 'aborted' };
      tierConsent = true;
    }
    outcome.tierDropped = ranDown;

    if (builderAccount && profile.account === builderAccount && policy.onSameAccountReview !== 'auto' && !sameAccountConsent && !request.profile) {
      const options = [
        { key: 'y', label: `review on ${profile.account}, the same account that built it` },
        { key: 'a', label: 'abort' },
      ];
      const question = `The only usable ${bindingRole} profile (${id}) shares an account with the Builder of ${task}.`;
      if (request.mode === 'headless') return { ...outcome, status: 'needs_choice', choice: { question, options: options.map((o) => o.label) } };
      if ((await ask(question, options)) !== 'y') return { ...outcome, status: 'aborted', message: 'aborted' };
      sameAccountConsent = true;
    }

    let prompt = hasHandoff(repoRoot, task)
      ? `${basePrompt}\n\n---\nA previous agent was interrupted on this task. Read ${handoffPath(repoRoot, task)} first and continue from the current working-directory state.`
      : basePrompt;
    if (outcome.tierDropped && bindingRole === 'architect') {
      prompt += '\n\n---\nThis plan is being produced on a lighter-tier model. Put the line `plan-tier: lite` at the top of the plan so a human knows to re-review it.';
    }

    // The same agent coming back after its own limit resumes its own conversation; any other
    // agent starts fresh from the handoff. A failed resume falls back to a fresh start.
    let resume = request.mode === 'headless' ? resumableSession(repoRoot, task, id) : null;
    const resumePrompt = `Your usage limit has reset. Continue the task from where you stopped. Handoff notes: ${handoffPath(repoRoot, task)}`;
    let result;
    let recordPath;
    for (let attempt = 0; ; attempt++) {
      ({ result, recordPath } = await runOnce({ agent, profile, account, prompt: resume ? resumePrompt : prompt, resume, request, task, repoRoot, bindingRole, tierDropped: outcome.tierDropped, now }));
      outcome.runs.push({ profile: id, account: profile.account, result, recordPath, resumed: Boolean(resume) });
      if (resume && result.kind === 'crashed') { resume = null; continue; }
      if (result.kind !== 'rate_limited' || attempt >= config.defaults.transientRetries) break;
      await sleep(5000 * 2 ** attempt);
    }

    if (result.kind === 'ok') {
      archiveHandoff(repoRoot, task);
      return { ...outcome, status: 'ok', profile: id };
    }
    if (result.kind === 'crashed') {
      const handoff = writeHandoff(repoRoot, task, { cwd: request.cwd, reason: result.message ?? 'crashed', profile: id, tail: result.tail });
      return { ...outcome, status: 'crashed', profile: id, message: result.message, handoff };
    }

    // usage_limit, or a rate limit that outlasted its retries: fall through to the next profile.
    if (result.kind === 'usage_limit') {
      const until = result.resetAt ?? new Date(now().getTime() + config.defaults.cooldownMinutes * 60_000);
      pauseAccount(profile.account, until, { reason: 'usage limit', seenOn: task });
      problems.push({ id, paused: until });
    } else {
      problems.push({ id, problem: `rate limited: ${result.message ?? ''}` });
    }
    outcome.handoff = writeHandoff(repoRoot, task, { cwd: request.cwd, reason: result.message ?? result.kind, profile: id, tail: result.tail });
  }

  const resumeAt = earliest(problems.map((p) => p.paused));
  if (resumeAt) return { ...outcome, status: 'waiting', resumeAt, message: `every ${bindingRole} profile is limited` };
  return { ...outcome, status: 'crashed', message: problems.map((p) => `${p.id}: ${p.problem}`).join('; ') || 'no usable profile' };
}

/**
 * Chain order for a request. Reviews of a task move profiles on the Builder's account to the end.
 * @returns {string[]}
 */
function orderChain(config, policy, builderAccount) {
  if (!builderAccount) return policy.chain;
  const other = policy.chain.filter((id) => config.profiles[id].account !== builderAccount);
  return [...other, ...policy.chain.filter((id) => config.profiles[id].account === builderAccount)];
}

/** Launch one profile, tee its events into a run record, and classify the result. */
function runOnce({ agent, profile, account, prompt, resume, request, task, repoRoot, bindingRole, tierDropped, now }) {
  const launch = agent.launch(profile, account, prompt, { mode: request.mode, cwd: request.cwd, resume });
  const startedAt = now().toISOString();
  const run = request.mode === 'headless' ? startRun(repoRoot, task, profile.id) : null;
  const classifier = request.mode === 'headless' ? agent.classifier(now) : null;

  return new Promise((resolve) => {
    const finish = (result) => {
      const recordPath = run?.finish({ role: bindingRole, profile: profile.id, account: profile.account, startedAt, endedAt: now().toISOString(), result, tierDropped, evidence: gitEvidence(request.cwd) });
      resolve({ result, recordPath });
    };
    const child = spawn(launch.command, launch.args, {
      cwd: request.cwd,
      env: process.env,
      stdio: classifier ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (classifier) {
      createInterface({ input: child.stdout }).on('line', (line) => { run.events.write(line + '\n'); classifier.onLine(line); });
      child.stderr.on('data', (d) => run.events.write(d));
    }
    child.on('error', (e) => finish({ kind: 'crashed', message: `could not launch ${launch.command}: ${e.message}` }));
    child.on('close', (code) => finish(classifier ? classifier.finish(code) : { kind: code === 0 ? 'ok' : 'crashed', message: code === 0 ? undefined : `exit ${code}` }));
  });
}

/** Dry run: resolved chain with each profile's launch command, prompt redacted. */
function describe(config, agents, chain, prompt, request) {
  const plan = chain.map((id) => {
    const profile = config.profiles[id];
    const account = config.accounts[profile.account];
    const { command, args } = agents[account.agent].launch(profile, account, prompt, { mode: request.mode, cwd: request.cwd });
    return { profile: id, command, args: args.map((a) => (a === prompt ? '<role-prompt>' : a)) };
  });
  return { status: 'ok', tierDropped: false, runs: [], plan };
}

function buildPrompt(request, task) {
  if (request.raw) {
    if (!request.message) throw new Error('--raw requires an initial message');
    return request.message;
  }
  const file = path.join(COMMANDS_DIR, `${ROLE_COMMANDS[request.role]}.md`);
  if (!existsSync(file)) throw new Error(`could not find ${file}`);
  const body = readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim().replaceAll('$ARGUMENTS', request.message ?? task);
  return request.role === 'escalation'
    ? `You are handling an escalated Builder task after two failed focused attempts. Diagnose the recorded blocker, complete the task, and preserve the task status contract.\n\n${body}`
    : body;
}

const adhocId = (d) => `adhoc-${d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;
const earliest = (dates) => dates.filter(Boolean).sort((a, b) => a - b)[0];

/** Terminal prompt; null when stdin is not a TTY so callers treat it as "cannot ask". */
async function askOnTty(question, options) {
  if (!process.stdin.isTTY) return null;
  console.error(`\n${question}`);
  for (const o of options) console.error(`  [${o.key}] ${o.label}`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((r) => rl.question('> ', r));
  rl.close();
  return options.find((o) => o.key === answer.trim().toLowerCase())?.key ?? null;
}

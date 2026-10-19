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
import { markActive, stopRequested } from './active.mjs';
import { decisionPrompt, escalationPath } from './escalations.mjs';
import { feedbackPrompt } from './prflow.mjs';
import { recordWip, wipPrompt } from './wip.mjs';
import { findingsPrompt, previousRoundPrompt } from './rounds.mjs';
import { integrationPrompt } from './integrate.mjs';
import { decisionsPrompt } from './scope.mjs';
import { renderSkillsBlock, resolveSkills } from './skills.mjs';
import { archiveHandoff, gitEvidence, handoffPath, hasHandoff, lastAccountFor, repoRootFor, resumableSession, startRun, writeHandoff } from './runs.mjs';

const COMMANDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands');
const ROLE_COMMANDS = { architect: 'plan', builder: 'build', worker: 'review', review: 'review', docs: 'docs', escalation: 'build', replan: 'replan' };
const TIER_RANK = { lite: 0, top: 1 };
const TASK_ID = /^(?:TASK|FIX|QUICK)-\S+$/;

/** @typedef {'architect' | 'builder' | 'worker' | 'review' | 'docs' | 'escalation' | 'fan'} RoleName */

/**
 * @typedef {object} DispatchRequest
 * @property {RoleName} role
 * @property {string} [task]       task id (TASK-, FIX-, QUICK-); enables handoff resume and cross-account review
 * @property {string} [message]    free text for the role prompt's $ARGUMENTS (or the raw prompt with `raw`)
 * @property {boolean} [raw]       send `message` as-is instead of the role prompt
 * @property {'interactive' | 'headless'} mode
 * @property {string} cwd
 * @property {string} [repoRoot]   where .role-router/ lives; defaults to the main checkout of cwd
 * @property {string} [profile]    explicit override: run exactly this profile, no fallback
 * @property {boolean} [dryRun]    resolve the chain and describe the launches; spawn nothing
 * @property {string[]} [addDirs]  extra repos the agent may write (replan across repos)
 * @property {string} [resume]     resume this agent session (project sessions)
 * @property {string} [sessionId]  start a new session with this id (Claude Code)
 * @property {boolean} [fullAccess] no workspace sandbox (a project session drives other agents)
 * @property {number} [timeoutMinutes]  headless wall-clock limit per agent run (default: config.defaults.runTimeoutMinutes)
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
 * @property {{ loaded: string[], missing: string[], stacks: string[] }} [skills]  skills handed to the last profile
 * @property {Array<{ profile: string, command: string, args: string[], skills?: string[], references?: string[] }>} [plan]  dry runs only
 */

/**
 * Test seams; production callers pass nothing.
 * @typedef {object} Deps
 * @property {Record<string, import('./agents/types.mjs').Agent>} [agents]
 * @property {import('./config.mjs').Config} [config]
 * @property {() => Date} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {(question: string, options: Array<{ key: string, label: string }>) => Promise<string | null>} [ask]
 * @property {(args: { role: string, agent: string, repoRoot: string }) => ReturnType<typeof resolveSkills>} [skills]
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
  const skillsFor = deps.skills ?? resolveSkills;
  const config = deps.config ?? loadConfig();

  const bindingRole = ['review', 'docs'].includes(request.role) ? 'worker' : request.role === 'replan' ? 'architect' : request.role;
  // A pinned profile needs no role chain: `fan` runs one raw prompt on explicit profiles.
  const policy = config.roles[bindingRole] ?? (request.profile ? { chain: [request.profile], onTierDrop: 'auto' } : null);
  if (!policy) throw new Error(`role ${bindingRole} has no chain in the config`);

  const repoRoot = request.repoRoot ?? repoRootFor(request.cwd);
  const task = request.task ?? (TASK_ID.test(request.message ?? '') ? request.message : adhocId(now()));
  const builderAccount = bindingRole === 'worker' && policy.avoidBuilderAccount ? lastAccountFor(repoRoot, task, ['builder', 'escalation']) : null;
  const chain = request.profile ? [request.profile] : orderChain(config, policy, builderAccount);
  for (const id of chain) if (!config.profiles[id]) throw new Error(`unknown profile "${id}"`);

  const basePrompt = buildPrompt(request, task);
  const headTier = TIER_RANK[config.profiles[chain[0]].tier];

  if (request.dryRun) return describe(config, agents, chain, basePrompt, request, repoRoot, skillsFor);

  /** @type {Outcome} */
  const outcome = { status: 'crashed', tierDropped: false, runs: [] };
  const problems = [];
  let tierConsent = false;
  let sameAccountConsent = false;

  for (const id of chain) {
    if (request.mode === 'headless' && stopRequested(repoRoot, task)) {
      return { ...outcome, status: 'aborted', message: 'stopped by user' };
    }
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

    const skills = request.raw ? null : skillsFor({ role: request.role, agent: account.agent, repoRoot });
    outcome.skills = skills && { loaded: skills.skills.map((x) => x.name), missing: skills.missing, stacks: skills.stacks };
    const skillsBlock = skills ? renderSkillsBlock(skills) : '';
    let prompt = skillsBlock ? `${basePrompt}\n\n---\n${skillsBlock}` : basePrompt;
    prompt = hasHandoff(repoRoot, task)
      ? `${prompt}\n\n---\nA previous agent was interrupted on this task. Read ${handoffPath(repoRoot, task)} first and continue from the current working-directory state.`
      : prompt;
    if (!request.raw) {
      const projectDecisions = decisionsPrompt(repoRootFor(repoRoot));
      if (projectDecisions) prompt += `\n\n---\n${projectDecisions}`;
    }
    if (!request.raw && /^(FIX|QUICK)-/.test(task)) {
      // Quick-task specs live in the main checkout; from a task worktree the relative path does not exist.
      prompt += `\n\n---\nThis is a quick task: its spec is ${path.join(repoRoot, '.role-router', 'tasks', `${task}.md`)} (write your Notes there).`;
    }
    if (!request.raw && ['builder', 'escalation', 'review', 'worker', 'docs'].includes(request.role)) {
      const decided = decisionPrompt(repoRoot, task);
      if (decided) prompt += `\n\n---\n${decided}`;
      const feedback = ['builder', 'escalation', 'review'].includes(request.role) ? feedbackPrompt(repoRoot, task) : '';
      if (feedback) prompt += `\n\n---\n${feedback}`;
      const wip = request.mode === 'headless' ? wipPrompt(repoRoot, task, request.cwd) : '';
      if (wip) prompt += `\n\n---\n${wip}`;
      if (task) {
        const reviewing = ['review', 'worker'].includes(request.role);
        const rounds = reviewing ? previousRoundPrompt(repoRoot, task) : request.role === 'docs' ? '' : findingsPrompt(repoRoot, task);
        if (rounds) prompt += `\n\n---\n${rounds}`;
        const base = request.role === 'docs' ? '' : integrationPrompt(repoRoot, task, reviewing ? 'review' : 'builder');
        if (base) prompt += `\n\n---\n${base}`;
      }
      prompt += `\n\n---\n## If you stop for a decision\nWhen you stop because a human or the Architect must decide (status human_needed, or a build you escalate), first write this block to ${escalationPath(repoRoot, task)}:\n\n### Escalation\n- type: design | product | environment | stuck-build | review-gaps\n- question: <one line a human can answer>\n- options:\n  1. <option>\n  2. <option>\n- recommendation: <option number, with one line of why>\n- affects: <task ids this decision changes, Repo:TASK-ID for other repos>`;
    }
    if (outcome.tierDropped && bindingRole === 'architect') {
      prompt += '\n\n---\nThis plan is being produced on a lighter-tier model. Put the line `plan-tier: lite` at the top of the plan so a human knows to re-review it.';
    }

    // The same agent coming back after its own limit resumes its own conversation; any other
    // agent starts fresh from the handoff. A failed resume falls back to a fresh start.
    let resume = request.resume ?? (request.mode === 'headless' ? resumableSession(repoRoot, task, id) : null);
    const resumePrompt = `Your usage limit has reset. Continue the task from where you stopped. Handoff notes: ${handoffPath(repoRoot, task)}`;
    let result;
    let recordPath;
    for (let attempt = 0; ; attempt++) {
      ({ result, recordPath } = await runOnce({ agent, profile, account, prompt: resume && !request.raw ? resumePrompt : prompt, resume, request, task, repoRoot, bindingRole, tierDropped: outcome.tierDropped, now, config }));
      outcome.runs.push({ profile: id, account: profile.account, result, recordPath, resumed: Boolean(resume) });
      if (result.kind === 'stopped') break;
      if (resume && result.kind === 'crashed') { resume = null; continue; }
      if (result.kind !== 'rate_limited' || attempt >= config.defaults.transientRetries) break;
      await sleep(5000 * 2 ** attempt);
    }

    if (result.kind === 'ok') {
      archiveHandoff(repoRoot, task);
      return { ...outcome, status: 'ok', profile: id };
    }
    // Handoffs carry task work between agents; a fan lane is a one-off question, not a task.
    const handsOff = request.role !== 'fan';
    if (result.kind === 'stopped') {
      const handoff = handsOff ? writeHandoff(repoRoot, task, { cwd: request.cwd, reason: 'stopped by user', profile: id, tail: result.tail }) : undefined;
      return { ...outcome, status: 'aborted', profile: id, message: 'stopped by user', handoff };
    }
    if (result.kind === 'crashed') {
      const handoff = handsOff ? writeHandoff(repoRoot, task, { cwd: request.cwd, reason: result.message ?? 'crashed', profile: id, tail: result.tail }) : undefined;
      return { ...outcome, status: 'crashed', profile: id, message: result.message, handoff };
    }

    // usage_limit / unavailable account, or a rate limit that outlasted its retries: fall through.
    if (result.kind === 'usage_limit' || result.kind === 'unavailable') {
      const until = result.resetAt ?? new Date(now().getTime() + config.defaults.cooldownMinutes * 60_000);
      const reason = result.kind === 'usage_limit' ? 'usage limit' : `account unavailable: ${(result.message ?? '').slice(0, 120)}`;
      pauseAccount(profile.account, until, { reason, seenOn: task });
      problems.push({ id, paused: until });
    } else {
      problems.push({ id, problem: `rate limited: ${result.message ?? ''}` });
    }
    if (handsOff) outcome.handoff = writeHandoff(repoRoot, task, { cwd: request.cwd, reason: result.message ?? result.kind, profile: id, tail: result.tail });
  }

  const resumeAt = earliest(problems.map((p) => p.paused));
  const unusable = problems.filter((p) => p.problem).map((p) => `${p.id}: ${p.problem}`);
  if (resumeAt) {
    const why = unusable.length ? `; not usable: ${unusable.join('; ')}` : '';
    return { ...outcome, status: 'waiting', resumeAt, message: `every usable ${bindingRole} profile is limited${why}` };
  }
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
function runOnce({ agent, profile, account, prompt, resume, request, task, repoRoot, bindingRole, tierDropped, now, config }) {
  const launch = agent.launch(profile, account, prompt, { mode: request.mode, cwd: request.cwd, resume, repoRoot, addDirs: request.addDirs, fullAccess: request.fullAccess, sessionId: request.sessionId });
  const startedAt = now().toISOString();
  const run = request.mode === 'headless' ? startRun(repoRoot, task, profile.id) : null;
  const classifier = request.mode === 'headless' ? agent.classifier(now) : null;

  // Headless runs get a wall-clock limit: a hung agent (seen live: an OpenCode run that never
  // emitted an event) must not stall the loop. A timeout is transient: retried, then the chain moves on.
  const timeoutMs = request.mode === 'headless' ? (request.timeoutMinutes ?? config.defaults.runTimeoutMinutes) * 60_000 : 0;

  return new Promise((resolve) => {
    let done = false;
    let timedOut = false;
    let stopped = false;
    let timer;
    let poll;
    let unmark = () => {};
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      unmark();
      const recordPath = run?.finish({ role: bindingRole, operation: request.role, profile: profile.id, account: profile.account, startedAt, endedAt: now().toISOString(), result, tierDropped, evidence: gitEvidence(request.cwd) });
      // What this run left uncommitted is the task's work in progress for the next run.
      if (run && TASK_ID.test(task ?? '')) { try { recordWip(repoRoot, task, request.cwd, path.basename(recordPath ?? '', '.json')); } catch { /* best effort */ } }
      resolve({ result, recordPath });
    };
    // Headless agents get their own process group, so a stop, a timeout or Ctrl+C ends the agent
    // and everything it started (seen live: an OpenCode run outlived its launch by eleven hours).
    const headless = Boolean(classifier);
    const child = spawn(launch.command, launch.args, {
      cwd: request.cwd,
      env: launch.env ? { ...process.env, ...launch.env } : process.env,
      stdio: headless ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      detached: headless,
    });
    const kill = (sig) => {
      try { if (headless) process.kill(-child.pid, sig); else child.kill(sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    const end = () => { kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 5000).unref(); };
    if (classifier) {
      createInterface({ input: child.stdout }).on('line', (line) => { run.events.write(line + '\n'); classifier.onLine(line); });
      child.stderr.on('data', (d) => run.events.write(d));
      // Visible to `role-router watch`; a stop request ends the agent within about a second.
      unmark = markActive(repoRoot, task, { pid: child.pid, profile: profile.id, account: profile.account, operation: request.role, eventsPath: run.eventsPath, cwd: request.cwd });
      poll = setInterval(() => {
        if (!stopped && stopRequested(repoRoot, task)) {
          stopped = true;
          end();
        }
      }, 1000);
      poll.unref?.();
      // Ctrl+C or a kill of role-router itself: end the agent and remove the marker, then exit as asked.
      // A short grace period, then a hard kill of the group before exiting: the agent no longer shares
      // the terminal's process group, so nothing else would end it.
      const onSignal = (sig) => {
        stopped = true;
        kill('SIGTERM');
        unmark();
        setTimeout(() => { kill('SIGKILL'); process.exit(sig === 'SIGINT' ? 130 : 143); }, 1500);
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      const forget = () => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); };
      child.once('close', forget);
      // The agent is done once it exits. Whatever it left running in its group (a dev server, a test
      // database) is ended, and its output pipes are closed if something outside the group still
      // holds them; otherwise the run would never finish.
      child.once('exit', () => {
        end();
        setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 10_000).unref();
      });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        end();
      }, timeoutMs);
    }
    child.on('error', (e) => finish({ kind: 'crashed', message: `could not launch ${launch.command}: ${e.message}` }));
    child.on('close', (code) => {
      if (stopped) return finish({ kind: 'stopped', message: 'stopped by user', tail: classifier?.finish(code).tail });
      if (timedOut) {
        const minutes = Math.round(timeoutMs / 60_000 * 10) / 10;
        return finish({ kind: 'rate_limited', message: `no result after ${minutes} min; stopped (treated as transient)`, tail: classifier?.finish(code).tail });
      }
      finish(classifier ? classifier.finish(code) : { kind: code === 0 ? 'ok' : 'crashed', message: code === 0 ? undefined : `exit ${code}` });
    });
  });
}

/** Dry run: resolved chain with each profile's launch command, prompt redacted. */
function describe(config, agents, chain, prompt, request, repoRoot, skillsFor) {
  const plan = chain.map((id) => {
    const profile = config.profiles[id];
    const account = config.accounts[profile.account];
    // Mirror the real launch exactly, so --dry-run / --print never misrepresent what would run.
    const { command, args } = agents[account.agent].launch(profile, account, prompt, { mode: request.mode, cwd: request.cwd, repoRoot, resume: request.resume, addDirs: request.addDirs, fullAccess: request.fullAccess, sessionId: request.sessionId });
    const resolved = request.raw ? null : skillsFor({ role: request.role, agent: account.agent, repoRoot });
    return {
      profile: id, command, args: args.map((a) => (a === prompt ? '<role-prompt>' : a)),
      skills: resolved?.skills.map((x) => x.name) ?? [],
      references: resolved?.references?.map((x) => x.name) ?? [],
    };
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
  const [argument, ...extra] = (request.message ?? task).split('\n\n');
  const body = readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim().replaceAll('$ARGUMENTS', request.role === 'replan' ? argument : (request.message ?? task)) + (request.role === 'replan' && extra.length ? `\n\n---\n${extra.join('\n\n')}` : '');
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

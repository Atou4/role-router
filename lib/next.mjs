// Role Router — one deterministic iteration of the delivery loop (the code form of /next).
//
//   pick → Builder → (status review?) → Worker review → (status passed?) → Worker docs
//
// Before each Builder pass and each review the base branch is merged into the task branch
// (lib/integrate.mjs), so what is reviewed is what the PR merges. Review rounds that bring new
// findings earn a repair pass; only rounds without progress count against the limit (lib/rounds.mjs).
//
// The scheduler reads task status from PLAN.md after every step; agents only do the Role
// work and write the status the contract asks for. A passed task's PR is opened (or updated)
// automatically on GitHub (config pr.auto); merging always stays with the human.

import { dispatch as realDispatch } from './dispatch.mjs';
import { depStatus, isBuildable, loadBoard, setStatus } from './board.mjs';
import { countRuns, hasHandoff, lastOperation, repoRootFor } from './runs.mjs';
import { clearStop } from './active.mjs';
import { loadConfig } from './config.mjs';
import path from 'node:path';
import { archiveEscalation, blockersOf, ensureEscalation } from './escalations.mjs';
import { notify } from './notify.mjs';
import { syncRepo } from './sync.mjs';
import { autoOpen as realAutoOpen } from './prflow.mjs';
import { integrateBase } from './integrate.mjs';
import { openReview, roundOutcome, verdictOf } from './rounds.mjs';

export { verdictOf };

/**
 * @typedef {object} NextResult
 * @property {'passed' | 'drained' | 'human_needed' | 'gaps_found' | 'waiting' | 'needs_choice' | 'disputed' | 'conflicts' | 'crashed' | 'aborted' | 'stuck'} stop
 * @property {string} [task]
 * @property {string} message
 * @property {Array<{ role: string, status: string, profiles: string[] }>} steps
 * @property {Date} [resumeAt]
 * @property {boolean} [retro]   the task needed more than one review round
 * @property {string} [detail]    what the inbox entry shows (default: the last agent's words)
 */

/**
 * @param {{ root: string, task?: string, dispatch?: typeof realDispatch, deps?: object, policy?: Partial<typeof ESCALATION_DEFAULTS> }} opts
 * @returns {Promise<NextResult>}
 */
export async function runNext(args) {
  const result = await advance(args);
  return settle(args.root, result, { ...ESCALATION_DEFAULTS, ...(args.policy ?? configuredPolicy()) }, args.autoOpen ?? realAutoOpen);
}

const STOP_TYPES = { human_needed: 'design', needs_choice: 'stuck-build', gaps_found: 'review-gaps', disputed: 'review-gaps', conflicts: 'stuck-build', stuck: 'environment', crashed: 'environment' };

/** After a task stops: file an escalation for anything that needs a human, and tell them. */
function settle(root, result, policy, autoOpen) {
  if (!result.task) return result;
  const main = repoRootFor(root);
  const repo = path.basename(main);
  const type = STOP_TYPES[result.stop];
  if (type) {
    const said = result.steps.at(-1)?.said;
    // Seen live: a Builder listed what it needed under "Not done" and the inbox only said "it stopped".
    const blockers = result.stop === 'human_needed' && typeof said === 'string' ? blockersOf(said) : [];
    const question = blockers.length ? `${result.task} is blocked on: ${blockers.join('; ')}`.slice(0, 600) : result.message;
    ensureEscalation(main, result.task, { type, question, detail: result.detail ?? (typeof said === 'string' ? said.slice(-2500) : undefined) });
    if (policy.notify) notify(`role-router · ${repo}:${result.task} needs you`, `${result.stop}: ${result.message.slice(0, 150)} · role-router inbox`);
  } else if (result.stop === 'passed') {
    archiveEscalation(main, result.task);
    const pr = autoOpen(main, result.task);
    result.pr = pr;
    if (pr.url) result.message = result.message.replace('merge the PR to mark it done', `PR opened: ${pr.url}; merge it, then role-router sync`);
    else if (pr.error) result.message += ` Opening the PR failed (${pr.error}); retry: role-router pr ${repo}:${result.task}`;
    if (policy.notify) notify(`role-router · ${repo}:${result.task} passed`, pr.url ? `PR ready to merge: ${pr.url}` : `Open its PR: role-router pr ${repo}:${result.task}`);
  }
  return result;
}

async function advance({ root, task, dispatch = realDispatch, deps, integrate = (id) => integrateBase(root, id), ...opts }) {
  const steps = [];
  const board = () => loadBoard(root) ?? (() => { throw new Error('No tasks here: run the Architect role, or role-router fix|quick.'); })();
  const statusOf = (id) => board().byId.get(id)?.status;

  // A task waiting on a human blocks only its own dependents (they are not buildable until it is
  // done). An explicitly named task always runs; auto-pick skips past waiting tasks.
  if (!task && opts.sync !== false) { try { syncRepo(root); } catch { /* best effort */ } } // merged PRs unblock dependents
  const picked = task ?? pick(board(), root);
  if (!picked) {
    const waiting = board().list.filter((t) => t.status === 'human_needed').map((t) => t.id);
    return waiting.length
      ? { stop: 'human_needed', task: waiting[0], message: `nothing else is buildable; waiting on you: ${waiting.join(', ')}`, steps }
      : { stop: 'drained', message: 'nothing buildable: every task is done, in flight, or blocked', steps };
  }
  if (!board().byId.has(picked)) throw new Error(`Unknown task "${picked}".`);
  clearStop(repoRootFor(root), picked); // starting a task on purpose withdraws an old stop request
  // A named task is checked here, before any paid run: the Builder would only refuse it.
  const named = board().byId.get(picked);
  const open = named.depends.filter((d) => depStatus(board(), d) !== 'done');
  if (['planned', 'gaps_found'].includes(named.status) && open.length) {
    return { stop: 'stuck', task: picked, steps: [], message: `${picked} depends on ${open.join(', ')}, which ${open.length > 1 ? 'are' : 'is'} not done yet` };
  }

  const run = async (role) => {
    const before = statusOf(picked);
    const out = await dispatch({ role, task: picked, message: picked, mode: 'headless', cwd: root }, deps);
    // A stopped run leaves no result: the board goes back to where it was (seen live: stopping a
    // needless rebuild left a task that had passed at gaps_found).
    if (out.status === 'aborted' && statusOf(picked) !== before) setStatus(root, picked, before);
    const last = out.runs.at(-1)?.result;
    steps.push({ role, status: out.status, profiles: out.runs.map((r) => r.profile), said: last?.summary ?? last?.message ?? out.message });
    return out;
  };
  const halt = (out) => ({
    stop: out.status, task: picked, steps, resumeAt: out.resumeAt,
    message: out.status === 'waiting' ? `${out.message}; handoff kept for the next run` : (out.message ?? out.choice?.question ?? out.status),
  });

  const policy = { ...ESCALATION_DEFAULTS, ...(opts.policy ?? configuredPolicy()) };
  let reviewRounds = 0;
  let stalled = 0; // review rounds that made no progress (a finding kept after the fix)
  let conflicts = 0;
  const totalRounds = Math.max(policy.maxReviewRounds, policy.maxReviewRoundsTotal); // never below the stalled limit
  let escalated = false;
  let last = null; // role of the previous step

  // A small state machine over the board: each step reads the status and decides what runs next.
  // Routine stops are handled here (review gaps → rebuild, stuck build → one top-tier escalation);
  // everything else stops with a reason. Bounded, so it can never loop forever.
  for (let guard = 0; guard < 4 * totalRounds + 8; guard++) {
    const status = statusOf(picked);

    if (status === 'planned' || status === 'gaps_found') {
      if (last === 'builder' || last === 'escalation') {
        return { stop: 'stuck', task: picked, steps, message: `${picked} is still "${status}" after the ${last} ran; it did not start the task` };
      }
      if (status === 'gaps_found' && last === 'review' && (stalled >= policy.maxReviewRounds || reviewRounds >= totalRounds)) {
        const why = stalled >= policy.maxReviewRounds
          ? `${stalled} review round(s) that kept a finding after the fix`
          : `${reviewRounds} review rounds, the most allowed (escalation.maxReviewRoundsTotal)`;
        return { stop: 'gaps_found', task: picked, steps, message: `${picked} still has review gaps after ${why}; the findings are in its last review run record` };
      }
      integrate(picked); // conflicts go to the Builder in its prompt
      const built = await run('builder');
      if (built.status !== 'ok') return halt(built);
      last = 'builder';
      continue;
    }

    if (status === 'building') {
      if (last === null) { // resuming an interrupted build
        const built = await run('builder');
        if (built.status !== 'ok') return halt(built);
        last = 'builder';
        continue;
      }
      // The Builder (or escalation) left it building: it escalated after two diagnosed attempts.
      if (policy.autoEscalate && !escalated) {
        escalated = true;
        const esc = await run('escalation');
        if (esc.status !== 'ok') return halt(esc);
        last = 'escalation';
        continue;
      }
      return { stop: 'needs_choice', task: picked, steps, message: escalated
        ? `${picked} is still blocked after a top-tier escalation attempt; the blocker is noted in its spec. A human decision is needed.`
        : `${picked} was escalated by its Builder (two diagnosed attempts failed; blocker noted in the spec). Run: role-router run escalation ${picked}` };
    }

    if (status === 'review') {
      if (last === 'review') return { stop: 'stuck', task: picked, steps, message: `${picked} review ended without a verdict` };
      const merge = integrate(picked);
      if (merge.status === 'conflicts') {
        // Reviewing a branch that cannot merge would review the wrong code: the Builder merges first.
        if (++conflicts > 2) {
          return { stop: 'conflicts', task: picked, steps, message: `merging ${merge.target} into ${picked}'s branch still conflicts after two Builder passes (${merge.files.join(', ')}); merge it by hand, then role-router next ${picked}` };
        }
        setStatus(root, picked, 'gaps_found');
        steps.push({ role: 'integrate', status: 'conflicts', profiles: [], said: `merging ${merge.target} conflicts in ${merge.files.join(', ')}` });
        last = 'integrate';
        continue;
      }
      const previous = openReview(root, picked);
      const reviewed = await run('review');
      if (reviewed.status !== 'ok') return halt(reviewed);
      reviewRounds++;
      // The review prompt ends with the verdict on its own line. Seen live: a reviewer printed
      // `passed` but skipped the board command. Record the verdict from its final message then.
      if (statusOf(picked) === 'review') {
        const verdict = verdictOf(reviewed.runs.at(-1)?.result?.summary);
        if (verdict) setStatus(root, picked, verdict);
      }
      if (statusOf(picked) === 'gaps_found') {
        const summary = reviewed.runs.at(-1)?.result?.summary ?? '';
        const round = roundOutcome(root, picked, summary, previous?.rebuilt ? previous : null);
        if (round.dispute.length) {
          const tags = round.dispute.map((d) => `MF${d.tag}`).join(', ');
          return {
            stop: 'disputed', task: picked, steps,
            message: `${picked}: the reviewer kept ${tags} after the Builder disputed it; decide who is right`,
            detail: `Builder (answering review ${previous.run}):\n${round.dispute.map((d) => `- ${d.builder}`).join('\n')}\n\nReviewer:\n${summary.slice(-2000)}`,
          };
        }
        if (round.counts) stalled++;
      }
      last = 'review';
      continue;
    }

    if (status === 'passed') {
      const docs = await run('docs');
      if (docs.status !== 'ok') return halt(docs);
      const rounds = countRuns(root, picked, 'review');
      const retro = rounds > 1
        ? ` It took ${rounds} review rounds: run /retro so the repeated finding becomes a check (lint rule, hook, CI job) instead of another round.`
        : ' Optional: /retro after merging, to improve the agent setup rather than the code.';
      return { stop: 'passed', task: picked, steps, retro: rounds > 1, message: `${picked} passed review and docs; merge the PR to mark it done.${retro}` };
    }

    if (status === 'human_needed') {
      const who = last === 'review' ? 'review found' : last ? `${last === 'escalation' ? 'Escalation' : 'Builder'} stopped with` : 'is waiting on';
      return { stop: 'human_needed', task: picked, steps, message: `${picked} ${who} human_needed; reasons are in the task's spec/Notes and its last run record` };
    }

    return { stop: 'stuck', task: picked, steps, message: `${picked} is "${status}", not something the loop can advance` };
  }
  return { stop: 'stuck', task: picked, steps, message: `${picked} did not settle after ${steps.length} steps` };
}

export const ESCALATION_DEFAULTS = { maxReviewRounds: 2, maxReviewRoundsTotal: 4, autoEscalate: true, waitForLimits: true, notify: true };

function configuredPolicy() {
  try { return loadConfig().escalation ?? {}; } catch { return {}; }
}

/**
 * The status a stopped task resumes from once a human decided: the stage that stopped, never an
 * earlier one. A review or docs stop is not a reason to rebuild; the reviewer gets the decision and
 * sends it back to the Builder itself if the code has to change.
 */
export function resumeStatus(root, task, status) {
  if (['review', 'passed', 'gaps_found'].includes(status)) return status;
  const last = lastOperation(root, task);
  if (last === 'docs') return 'passed';
  if (last === 'review') return 'review';
  return countRuns(root, task, 'builder') > 0 ? 'gaps_found' : 'planned';
}

/** Rework first, then a stopped build with a handoff to resume, then the next buildable task. */
export function pick(board, root) {
  const { list } = board;
  return (list.find((t) => t.status === 'gaps_found')
    ?? list.find((t) => t.status === 'building' && hasHandoff(root, t.id))
    ?? list.find((t) => isBuildable(t, board)))?.id;
}

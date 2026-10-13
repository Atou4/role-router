// Role Router — one deterministic iteration of the delivery loop (the code form of /next).
//
//   pick → Builder → (status review?) → Worker review → (status passed?) → Worker docs
//
// The scheduler reads task status from PLAN.md after every step; agents only do the Role
// work and write the status the contract asks for. PR reconciliation (merged → done) stays
// with the human or the /next prompt: this loop never merges or opens PRs itself.

import { dispatch as realDispatch } from './dispatch.mjs';
import { depStatus, isBuildable, loadBoard, setStatus } from './board.mjs';
import { countRuns, hasHandoff, repoRootFor } from './runs.mjs';
import { clearStop } from './active.mjs';
import { loadConfig } from './config.mjs';
import path from 'node:path';
import { archiveEscalation, ensureEscalation } from './escalations.mjs';
import { notify } from './notify.mjs';
import { syncRepo } from './sync.mjs';

/**
 * @typedef {object} NextResult
 * @property {'passed' | 'drained' | 'human_needed' | 'gaps_found' | 'waiting' | 'needs_choice' | 'crashed' | 'aborted' | 'stuck'} stop
 * @property {string} [task]
 * @property {string} message
 * @property {Array<{ role: string, status: string, profiles: string[] }>} steps
 * @property {Date} [resumeAt]
 * @property {boolean} [retro]   the task needed more than one review round
 */

/**
 * @param {{ root: string, task?: string, dispatch?: typeof realDispatch, deps?: object, policy?: Partial<typeof ESCALATION_DEFAULTS> }} opts
 * @returns {Promise<NextResult>}
 */
export async function runNext(args) {
  const result = await advance(args);
  return settle(args.root, result, { ...ESCALATION_DEFAULTS, ...(args.policy ?? configuredPolicy()) });
}

const STOP_TYPES = { human_needed: 'design', needs_choice: 'stuck-build', gaps_found: 'review-gaps', stuck: 'environment', crashed: 'environment' };

/** After a task stops: file an escalation for anything that needs a human, and tell them. */
function settle(root, result, policy) {
  if (!result.task) return result;
  const main = repoRootFor(root);
  const repo = path.basename(main);
  const type = STOP_TYPES[result.stop];
  if (type) {
    const said = result.steps.at(-1)?.said;
    ensureEscalation(main, result.task, { type, question: result.message, detail: typeof said === 'string' ? said.slice(-2500) : undefined });
    if (policy.notify) notify(`role-router · ${repo}:${result.task} needs you`, `${result.stop}: ${result.message.slice(0, 150)} · role-router inbox`);
  } else if (result.stop === 'passed') {
    archiveEscalation(main, result.task);
    if (policy.notify) notify(`role-router · ${repo}:${result.task} passed`, 'Review and merge its PR (branch task/' + result.task + ').');
  }
  return result;
}

async function advance({ root, task, dispatch = realDispatch, deps, ...opts }) {
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
    const out = await dispatch({ role, task: picked, message: picked, mode: 'headless', cwd: root }, deps);
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
  let escalated = false;
  let last = null; // role of the previous step

  // A small state machine over the board: each step reads the status and decides what runs next.
  // Routine stops are handled here (review gaps → rebuild, stuck build → one top-tier escalation);
  // everything else stops with a reason. Bounded, so it can never loop forever.
  for (let guard = 0; guard < 4 * policy.maxReviewRounds + 8; guard++) {
    const status = statusOf(picked);

    if (status === 'planned' || status === 'gaps_found') {
      if (last === 'builder' || last === 'escalation') {
        return { stop: 'stuck', task: picked, steps, message: `${picked} is still "${status}" after the ${last} ran; it did not start the task` };
      }
      if (status === 'gaps_found' && reviewRounds >= policy.maxReviewRounds) {
        return { stop: 'gaps_found', task: picked, steps, message: `${picked} still has review gaps after ${reviewRounds} review round(s); the findings are in its last review run record` };
      }
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
      const reviewed = await run('review');
      if (reviewed.status !== 'ok') return halt(reviewed);
      reviewRounds++;
      // The review prompt ends with the verdict on its own line. Seen live: a reviewer printed
      // `passed` but skipped the board command. Record the verdict from its final message then.
      if (statusOf(picked) === 'review') {
        const verdict = verdictOf(reviewed.runs.at(-1)?.result?.summary);
        if (verdict) setStatus(root, picked, verdict);
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

export const ESCALATION_DEFAULTS = { maxReviewRounds: 2, autoEscalate: true, waitForLimits: true, notify: true };

function configuredPolicy() {
  try { return loadConfig().escalation ?? {}; } catch { return {}; }
}

/** The last line of a review that is exactly one of the verdict statuses, if any. */
export function verdictOf(text) {
  // Markdown is stripped first: seen live, "**Status:** `gaps_found`" followed by another sentence.
  const lines = (text ?? '').split('\n').map((l) => l.replace(/[*`#>]/g, '').trim().replace(/\.$/, '').replace(/(^|\s)_+|_+($|\s)/g, '$1$2').trim().toLowerCase()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(?:(?:final\s+)?(?:status|verdict)\s*:\s*)?(passed|gaps_found|human_needed)$/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/** Rework first, then a stopped build with a handoff to resume, then the next buildable task. */
export function pick(board, root) {
  const { list } = board;
  return (list.find((t) => t.status === 'gaps_found')
    ?? list.find((t) => t.status === 'building' && hasHandoff(root, t.id))
    ?? list.find((t) => isBuildable(t, board)))?.id;
}

// Role Router — one deterministic iteration of the delivery loop (the code form of /next).
//
//   pick → Builder → (status review?) → Worker review → (status passed?) → Worker docs
//
// The scheduler reads task status from PLAN.md after every step; agents only do the Role
// work and write the status the contract asks for. PR reconciliation (merged → done) stays
// with the human or the /next prompt: this loop never merges or opens PRs itself.

import { dispatch as realDispatch } from './dispatch.mjs';
import { isBuildable, loadBoard, setStatus } from './board.mjs';
import { countRuns, hasHandoff } from './runs.mjs';

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
 * @param {{ root: string, task?: string, dispatch?: typeof realDispatch, deps?: object }} opts
 * @returns {Promise<NextResult>}
 */
export async function runNext({ root, task, dispatch = realDispatch, deps }) {
  const steps = [];
  const board = () => loadBoard(root) ?? (() => { throw new Error('No tasks here: run the Architect role, or role-router fix|quick.'); })();
  const statusOf = (id) => board().byId.get(id)?.status;

  // A task waiting on a human blocks only its own dependents (they are not buildable until it is
  // done). An explicitly named task always runs; auto-pick skips past waiting tasks.
  const picked = task ?? pick(board(), root);
  if (!picked) {
    const waiting = board().list.filter((t) => t.status === 'human_needed').map((t) => t.id);
    return waiting.length
      ? { stop: 'human_needed', task: waiting[0], message: `nothing else is buildable; waiting on you: ${waiting.join(', ')}`, steps }
      : { stop: 'drained', message: 'nothing buildable: every task is done, in flight, or blocked', steps };
  }
  if (!board().byId.has(picked)) throw new Error(`Unknown task "${picked}".`);
  // A named task is checked here, before any paid run: the Builder would only refuse it.
  const named = board().byId.get(picked);
  const open = named.depends.filter((d) => board().byId.get(d)?.status !== 'done');
  if (['planned', 'gaps_found'].includes(named.status) && open.length) {
    return { stop: 'stuck', task: picked, steps: [], message: `${picked} depends on ${open.join(', ')}, which ${open.length > 1 ? 'are' : 'is'} not done yet` };
  }

  const run = async (role) => {
    const out = await dispatch({ role, task: picked, message: picked, mode: 'headless', cwd: root }, deps);
    steps.push({ role, status: out.status, profiles: out.runs.map((r) => r.profile) });
    return out;
  };
  const halt = (out) => ({
    stop: out.status, task: picked, steps, resumeAt: out.resumeAt,
    message: out.status === 'waiting' ? `${out.message}; handoff kept for the next run` : (out.message ?? out.choice?.question ?? out.status),
  });

  const entry = statusOf(picked);
  if (['planned', 'gaps_found', 'building'].includes(entry)) {
    const built = await run('builder');
    if (built.status !== 'ok') return halt(built);
  } else if (entry !== 'review' && entry !== 'passed') {
    return { stop: 'stuck', task: picked, steps, message: `${picked} is "${entry}", not something the loop can advance` };
  }

  if (statusOf(picked) === 'review') {
    const reviewed = await run('review');
    if (reviewed.status !== 'ok') return halt(reviewed);
    // The review prompt ends with the verdict on its own line. Seen live: a reviewer printed
    // `passed` but skipped the board command. Record the verdict from its final message then.
    if (statusOf(picked) === 'review') {
      const verdict = verdictOf(reviewed.runs.at(-1)?.result?.summary);
      if (verdict) setStatus(root, picked, verdict);
    }
  }
  const after = statusOf(picked);
  if (after === 'gaps_found' || after === 'human_needed') return { stop: after, task: picked, steps, message: `${picked} review found: ${after}` };
  if (after === 'building') {
    return { stop: 'needs_choice', task: picked, steps, message: `${picked} was escalated by its Builder (two diagnosed attempts failed; blocker noted in the spec). Run: role-router run escalation ${picked}` };
  }
  if (after !== 'passed') return { stop: 'stuck', task: picked, steps, message: `${picked} ended the step at "${after}"; expected review or passed` };

  const docs = await run('docs');
  if (docs.status !== 'ok') return halt(docs);
  const rounds = countRuns(root, picked, 'review');
  const retro = rounds > 1
    ? ` It took ${rounds} review rounds: run /retro so the repeated finding becomes a check (lint rule, hook, CI job) instead of another round.`
    : ' Optional: /retro after merging, to improve the agent setup rather than the code.';
  return { stop: 'passed', task: picked, steps, retro: rounds > 1, message: `${picked} passed review and docs; merge the PR to mark it done.${retro}` };
}

/** The last line of a review that is exactly one of the verdict statuses, if any. */
export function verdictOf(text) {
  const lines = (text ?? '').split('\n').map((l) => l.trim().replace(/^[*`_#\s]+|[*`_.\s]+$/g, '').toLowerCase()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(?:status:\s*)?(passed|gaps_found|human_needed)$/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/** Rework first, then a stopped build with a handoff to resume, then the next buildable task. */
function pick(board, root) {
  const { list, byId } = board;
  return (list.find((t) => t.status === 'gaps_found')
    ?? list.find((t) => t.status === 'building' && hasHandoff(root, t.id))
    ?? list.find((t) => isBuildable(t, byId)))?.id;
}

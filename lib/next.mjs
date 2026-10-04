// Role Router — one deterministic iteration of the delivery loop (the code form of /next).
//
//   pick → Builder → (status review?) → Worker review → (status passed?) → Worker docs
//
// The scheduler reads task status from PLAN.md after every step; agents only do the Role
// work and write the status the contract asks for. PR reconciliation (merged → done) stays
// with the human or the /next prompt: this loop never merges or opens PRs itself.

import { dispatch as realDispatch } from './dispatch.mjs';
import { isBuildable, loadBoard } from './board.mjs';
import { hasHandoff } from './runs.mjs';

/**
 * @typedef {object} NextResult
 * @property {'passed' | 'drained' | 'human_needed' | 'gaps_found' | 'waiting' | 'needs_choice' | 'crashed' | 'aborted' | 'stuck'} stop
 * @property {string} [task]
 * @property {string} message
 * @property {Array<{ role: string, status: string, profiles: string[] }>} steps
 * @property {Date} [resumeAt]
 */

/**
 * @param {{ root: string, task?: string, dispatch?: typeof realDispatch, deps?: object }} opts
 * @returns {Promise<NextResult>}
 */
export async function runNext({ root, task, dispatch = realDispatch, deps }) {
  const steps = [];
  const board = () => loadBoard(root) ?? (() => { throw new Error('No PLAN.md here. Run the Architect role first.'); })();
  const statusOf = (id) => board().byId.get(id)?.status;

  const blocked = board().list.find((t) => t.status === 'human_needed');
  if (blocked) return { stop: 'human_needed', task: blocked.id, message: `${blocked.id} needs a human decision before the loop continues`, steps };

  const picked = task ?? pick(board(), root);
  if (!picked) return { stop: 'drained', message: 'nothing buildable: every task is done, in flight, or blocked', steps };
  if (!board().byId.has(picked)) throw new Error(`Unknown task "${picked}".`);

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
  }
  const after = statusOf(picked);
  if (after === 'gaps_found' || after === 'human_needed') return { stop: after, task: picked, steps, message: `${picked} review found: ${after}` };
  if (after !== 'passed') return { stop: 'stuck', task: picked, steps, message: `${picked} ended the step at "${after}"; expected review or passed` };

  const docs = await run('docs');
  if (docs.status !== 'ok') return halt(docs);
  return { stop: 'passed', task: picked, steps, message: `${picked} passed review and docs; merge the PR to mark it done` };
}

/** Rework first, then a stopped build with a handoff to resume, then the next buildable task. */
function pick(board, root) {
  const { list, byId } = board;
  return (list.find((t) => t.status === 'gaps_found')
    ?? list.find((t) => t.status === 'building' && hasHandoff(root, t.id))
    ?? list.find((t) => isBuildable(t, byId)))?.id;
}

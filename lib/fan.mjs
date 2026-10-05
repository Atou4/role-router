// Role Router — run one prompt on several profiles in parallel and collect each answer.
//
// The multi-model backend for skills that compare models (architect, arena, interrogate,
// how): each lane is a pinned-profile headless dispatch, so usage limits and run records
// behave as everywhere else. Lanes either stay read-only in the shared checkout, or each
// gets its own detached git worktree when candidates must write files.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dispatch as realDispatch } from './dispatch.mjs';
import { ensureStateDir, repoRootFor } from './runs.mjs';

/**
 * One top-tier profile per account (else the account's first profile), in config order.
 * @param {import('./config.mjs').Config} config
 */
export function defaultFanProfiles(config) {
  const byAccount = new Map();
  for (const [id, p] of Object.entries(config.profiles)) {
    const current = byAccount.get(p.account);
    if (!current || (current.tier !== 'top' && p.tier === 'top')) byAccount.set(p.account, { id, tier: p.tier });
  }
  return [...byAccount.values()].map((p) => p.id);
}

/**
 * @typedef {object} Lane
 * @property {string} profile
 * @property {'ok' | 'crashed' | 'waiting' | 'needs_choice' | 'aborted'} status
 * @property {string} [answer]    path of the lane's final answer (Markdown)
 * @property {string} [worktree]
 * @property {string} [message]
 */

/**
 * @param {{ prompt: string, profiles: string[], cwd: string, out?: string, worktree?: boolean,
 *           now?: () => Date, dispatch?: typeof realDispatch, deps?: object }} opts
 * @returns {Promise<{ out: string, lanes: Lane[] }>}
 */
export async function fan({ prompt, profiles, cwd, out, worktree = false, now = () => new Date(), dispatch = realDispatch, deps }) {
  if (!prompt?.trim()) throw new Error('fan needs a prompt');
  if (profiles.length === 0) throw new Error('fan needs at least one profile');
  const repoRoot = repoRootFor(cwd);
  const stamp = now().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dir = out ?? path.join(ensureStateDir(repoRoot), 'fan', stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'prompt.md'), prompt);

  const lanes = await Promise.all(profiles.map(async (profile) => {
    let laneCwd = cwd;
    let preface = 'You are one of several independent runners given the same task on different models. Do not modify any file in the repository. Give your complete answer as your final message.';
    if (worktree) {
      laneCwd = path.join(dir, `${profile}-worktree`);
      try {
        execFileSync('git', ['worktree', 'add', '--detach', laneCwd, 'HEAD'], { cwd: repoRoot, stdio: 'pipe' });
      } catch (e) {
        return { profile, status: 'crashed', message: `worktree: ${(e.stderr?.toString() || e.message).trim()}` };
      }
      preface = `You are one of several independent runners given the same task on different models. Work only inside ${laneCwd}, an isolated copy of the repository; write any artifacts there. Summarise what you produced, and where, in your final message.`;
    }
    const result = await dispatch(
      { role: 'fan', profile, raw: true, message: `${preface}\n\n---\n\n${prompt}`, mode: 'headless', cwd: laneCwd, repoRoot, task: `fan-${stamp}` },
      deps,
    );
    const last = result.runs.at(-1)?.result;
    const lane = { profile, status: result.status, ...(worktree && { worktree: laneCwd }), ...(result.message && { message: result.message }) };
    if (result.status === 'ok') {
      lane.answer = path.join(dir, `${profile}.md`);
      writeFileSync(lane.answer, `${last?.summary ?? ''}\n`);
    }
    return lane;
  }));

  writeFileSync(path.join(dir, 'fan.json'), JSON.stringify({ prompt: path.join(dir, 'prompt.md'), lanes }, null, 2) + '\n');
  return { out: dir, lanes };
}

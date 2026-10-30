// Role Router — keep a task branch current with the branch it merges into.
//
// Before every Builder pass and every review, the loop merges the base (origin/<base> when there is
// a remote, so unpushed local commits stay out of the PR) into the task branch. A clean merge is
// committed and reviewed like any other change; a conflicting one is cancelled and handed to the
// Builder, who merges it and resolves the conflicts as part of its pass. Either way the code that is
// reviewed is the code the PR will merge. The last attempt is kept in .role-router/runs/<ID>/integrate.json
// and read back into the next agent's prompt.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { effectiveBase } from './pr.mjs';
import { repoRootFor } from './runs.mjs';
import { dirtyFiles } from './wip.mjs';

const sh = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GIT_MERGE_AUTOEDIT: 'no' } });
const ok = (r) => (r.status === 0 ? r.stdout.trim() : null);
const statePath = (root, task) => path.join(repoRootFor(root), '.role-router', 'runs', task, 'integrate.json');

export function readIntegration(root, task) {
  try { return JSON.parse(readFileSync(statePath(root, task), 'utf8')); } catch { return null; }
}

/**
 * Merge the base into the task branch checked out at `cwd`. Never throws.
 * @returns {{ status: 'skipped'|'current'|'merged'|'conflicts'|'failed', target?: string, behind?: number, files?: string[], commit?: string, why?: string }}
 */
export function integrateBase(cwd, task, { git = sh } = {}) {
  const branch = ok(git(cwd, 'branch', '--show-current'));
  if (!branch?.startsWith('task/')) return { status: 'skipped', why: 'not on a task branch' };
  // Untracked leftovers do not block a merge (one in the way makes it fail, and the review goes on).
  if ([...(dirtyFiles(cwd)?.values() ?? [])].some((f) => f.tracked)) return { status: 'skipped', why: 'uncommitted changes' };
  const main = repoRootFor(cwd);
  if (ok(git(cwd, 'remote', 'get-url', 'origin')) !== null) git(cwd, 'fetch', '--quiet', 'origin'); // the default branch too, for effectiveBase
  const { base, from } = effectiveBase(main, task, branch, ok(git(cwd, 'rev-parse', 'HEAD')) ?? branch); // a sha: HEAD would mean the main checkout's
  const retargeted = from ? { retargeted: { from, to: base } } : {};
  let target = base;
  // Offline the fetch fails, and the last fetched origin/<base> still counts.
  if (ok(git(cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`))) target = `origin/${base}`;
  if (!ok(git(cwd, 'rev-parse', '--verify', '--quiet', target))) return save(cwd, task, { status: 'skipped', why: `no ${target} to merge`, ...retargeted });
  const behind = Number(ok(git(cwd, 'rev-list', '--count', `HEAD..${target}`)) ?? 0);
  if (!behind) return save(cwd, task, { status: 'current', target, behind: 0, ...retargeted });
  // --no-verify: commit hooks would run the gates on a merge nobody reviewed yet; the review does.
  const merged = git(cwd, 'merge', '--no-ff', '--no-verify', '-m', `Merge ${target} into ${branch}`, target);
  if (merged.status === 0) return save(cwd, task, { status: 'merged', target, behind, commit: ok(git(cwd, 'rev-parse', '--short', 'HEAD')), ...retargeted });
  const files = (ok(git(cwd, 'diff', '--name-only', '--diff-filter=U')) ?? '').split('\n').filter(Boolean);
  git(cwd, 'merge', '--abort');
  if (!files.length) return save(cwd, task, { status: 'failed', target, behind, why: `${merged.stderr}${merged.stdout}`.trim().split('\n').slice(-2).join(' '), ...retargeted });
  return save(cwd, task, { status: 'conflicts', target, behind, files, ...retargeted });
}

function save(cwd, task, result) {
  try {
    mkdirSync(path.dirname(statePath(cwd, task)), { recursive: true });
    writeFileSync(statePath(cwd, task), JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2) + '\n');
  } catch { /* the merge itself is what matters */ }
  return result;
}

/** The prompt section from the last attempt: conflicts for the Builder, the base to diff against for the reviewer. */
export function integrationPrompt(root, task, role) {
  const s = readIntegration(root, task);
  if (!s?.target) return '';
  if (role === 'review') {
    if (!['merged', 'current'].includes(s.status)) return '';
    const merged = s.status === 'merged' ? `Before this review, role-router merged ${s.behind} commit(s) from ${s.target} into the branch without conflicts (${s.commit}). The Builder's gate evidence predates that merge: rerun the gates if your environment can; if it cannot, note it as \`Unverified by reviewer:\` rather than a Must-fix, unless the merged commits change code this task changes.\n\n` : '';
    const moved = s.retargeted ? `The PR base is now ${s.retargeted.to} (was ${s.retargeted.from}: the branch already contains newer ${s.retargeted.to} work, which is not this task's).\n\n` : '';
    return `## The base\n${moved}${merged}Review the diff against ${s.target}, which is what the PR merges into: \`git diff ${s.target}...HEAD\`. A merge commit on the branch that resolved conflicts is part of the change: check the resolution keeps both sides' intent.`;
  }
  if (s.status !== 'conflicts') return '';
  return `## Bring in ${s.target} first (binding)\nThe task branch is ${s.behind} commit(s) behind ${s.target}, and merging it conflicts in:\n${s.files.map((f) => `- ${f}`).join('\n')}\n\nStart this pass with \`git merge ${s.target}\`. Resolve each conflict keeping both sides' intent: read the commits on ${s.target} that touched these files (\`git log HEAD..${s.target} -- <file>\`). Then run the full gates on the merged result, commit the merge, and continue with the rest of this pass.`;
}

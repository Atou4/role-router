// Role Router — open the PR for a passed task: commit leftovers, push its branch, create the PR.
//
// The branch is whatever the task's worktree is on (task/<ID>, or task/<ID>-… when the Builder had
// to pick another name). The base is the branch the task was cut from (recorded when the worktree
// was made; for older tasks, the candidate with the fewest commits between it and the task).
// The body is the docs step's "## PR body" section, saved to .role-router/runs/<ID>/PR.md.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { repoRootFor } from './runs.mjs';
import { unverifiedNotes } from './rounds.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const out = (r) => (r.status === 0 ? r.stdout.trim() : '');

export const worktreeDir = (root, id) => path.join(repoRootFor(root), '.role-router', 'worktrees', id);

/** The branch holding the task's work. */
export function taskBranch(root, id) {
  const wt = worktreeDir(root, id);
  if (existsSync(path.join(wt, '.git'))) {
    const b = out(git(wt, 'branch', '--show-current'));
    if (b) return b;
  }
  return out(git(repoRootFor(root), 'rev-parse', '--verify', `task/${id}`)) ? `task/${id}` : null;
}

/** The branch the task was cut from: recorded at creation, else the closest candidate. */
export function baseBranch(root, id, branch) {
  const main = repoRootFor(root);
  const recorded = path.join(main, '.role-router', 'worktrees', `${id}.base`);
  if (existsSync(recorded)) return readFileSync(recorded, 'utf8').trim();
  const originHead = out(git(main, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).replace(/^origin\//, '');
  const candidates = [...new Set([originHead, 'main', 'master', 'dev', 'develop'].filter(Boolean))]
    .filter((b) => out(git(main, 'rev-parse', '--verify', b)));
  let best = null;
  for (const b of candidates) {
    const ahead = Number(out(git(main, 'rev-list', '--count', `${b}..${branch}`)) || Infinity);
    if (!best || ahead < best.ahead) best = { b, ahead };
  }
  return best?.b || originHead || 'main';
}

/**
 * The base the task really merges into. A task cut from a plan branch whose head (`ref`, the
 * worktree's commit; never 'HEAD', which git reads in the main checkout) already took in newer commits of the default branch would carry that upstream
 * work into a PR against the plan branch, and its review would blame the task for it (seen live:
 * TASK-017 on plan/staging-phone-otp). Then the default branch is the base, and the record follows.
 * @returns {{ base: string, from?: string }}  `from` is set when the base was changed
 */
export function effectiveBase(root, id, branch, ref = branch) {
  const main = repoRootFor(root);
  const recorded = baseBranch(main, id, branch);
  const def = out(git(main, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).replace(/^origin\//, '')
    || ['main', 'master'].find((b) => out(git(main, 'rev-parse', '--verify', '--quiet', b)));
  if (!def || def === recorded) return { base: recorded };
  const refOf = (b) => [`origin/${b}`, b].find((r) => out(git(main, 'rev-parse', '--verify', '--quiet', r)));
  const baseRef = refOf(recorded);
  const defRef = refOf(def);
  if (!baseRef || !defRef) return { base: recorded };
  const fork = out(git(main, 'merge-base', ref, defRef));
  // The head's newest common point with the default branch is still inside the plan branch: it did not take in newer default work.
  if (!fork || git(main, 'merge-base', '--is-ancestor', fork, baseRef).status === 0) return { base: recorded };
  writeFileSync(path.join(main, '.role-router', 'worktrees', `${id}.base`), `${def}\n`);
  return { base: def, from: recorded };
}

/** The PR body from the latest successful docs run (its "## PR body" section, else the whole message). */
export function prBody(root, id) {
  const dir = path.join(repoRootFor(root), '.role-router', 'runs', id);
  if (!existsSync(dir)) return null;
  const docs = readdirSync(dir).filter((f) => /^\d+-.*\.json$/.test(f)).sort()
    .map((f) => { try { return JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter((r) => r?.operation === 'docs' && r.result?.kind === 'ok').at(-1);
  const text = docs?.result?.summary;
  if (!text) return null;
  const m = /^#{1,3}\s*PR body\s*$/im.exec(text);
  return (m ? text.slice(m.index + m[0].length) : text).trim();
}

/**
 * Plan (and with run=true, perform) opening the PR.
 * @returns {{ branch: string, base: string, title: string, bodyFile: string, leftovers: string[], steps: string[][], url?: string }}
 */
export function openPr(root, task, { base, draft = false, run = true, sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' }) } = {}) {
  const main = repoRootFor(root);
  const branch = taskBranch(main, task.id);
  if (!branch) throw new Error(`no branch for ${task.id} (expected a worktree under .role-router/worktrees/${task.id} or a task/${task.id} branch)`);
  const target = base ?? effectiveBase(main, task.id, branch).base;
  const body = prBody(main, task.id);
  if (!body) throw new Error(`no PR body for ${task.id}: its docs step has not run (role-router next ${task.id})`);
  const bodyFile = path.join(main, '.role-router', 'runs', task.id, 'PR.md');
  // What the reviewer could not check itself (its environment failed) is for the human merging it.
  const unverified = unverifiedNotes(main, task.id);
  writeFileSync(bodyFile, body + (unverified.length ? `\n\n## Not verified by the reviewer\n${unverified.map((l) => `- ${l}`).join('\n')}` : '') + '\n');
  const wt = worktreeDir(main, task.id);
  const cwd = existsSync(path.join(wt, '.git')) ? wt : main;
  // Porcelain lines are 'XY path': parse the raw output (trimming first would eat a status column).
  const raw = cwd === wt ? git(wt, 'status', '--porcelain', '--untracked-files=no').stdout ?? '' : '';
  const leftovers = raw.split('\n').filter((l) => l.length > 3).map((l) => l.slice(3));
  const title = `${task.id}: ${task.title}`;
  // An open PR for this branch is updated, never duplicated. The lookup fails closed on GitHub;
  // without a GitHub remote there can be no PR to find (and gh would only fail).
  let existing;
  if (/github\.com[:/]/.test(out(git(main, 'remote', 'get-url', 'origin')))) {
    // Seen live: with an invalid token and no connection, GitHub's "Head sha can't be blank" hid the cause.
    const auth = sh('gh', ['auth', 'status'], cwd);
    if (auth.status !== 0) {
      const why = `${auth.stderr ?? ''}${auth.stdout ?? ''}`.split('\n').map((l) => l.trim()).filter((l) => /fail|invalid|not logged|could not|error|timeout|connect/i.test(l)).slice(0, 2).join(' ');
      throw new Error(`GitHub is not available (gh auth status: ${why || `exit ${auth.status}`}); nothing was pushed or opened. Fix the sign-in (gh auth login) or the connection, then: role-router pr ${task.id}`);
    }
    const lookup = sh('gh', ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'headRefName,url'], cwd);
    if (lookup.status !== 0) throw new Error(`gh pr list failed: ${`${lookup.stderr ?? ''}${lookup.stdout ?? ''}`.trim()}`);
    try {
      const prs = JSON.parse(lookup.stdout);
      if (!Array.isArray(prs)) throw new Error('expected an array');
      existing = prs.find((pr) => pr.headRefName === branch);
    } catch (e) { throw new Error(`gh pr list returned invalid JSON: ${e.message}`); }
  }
  const steps = [
    ...(leftovers.length ? [['git', 'commit', '-am', `${task.id}: docs`]] : []),
    ['git', 'push', '-u', 'origin', branch],
    ['gh', 'pr', existing ? 'edit' : 'create', ...(existing ? [existing.url, '--body-file', bodyFile] : ['--base', target, '--head', branch, '--title', title, '--body-file', bodyFile, ...(draft ? ['--draft'] : [])])],
  ];
  const result = { branch, base: target, title, bodyFile, leftovers, steps, ...(existing ? { url: existing.url, updated: true } : {}) };
  if (!run) return result;
  for (const [cmd, ...args] of steps) {
    const r = sh(cmd, args, cwd);
    if (r.status !== 0) {
      const err = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim();
      if (cmd === 'gh' && /already exists/i.test(err)) {
        // New commits are pushed already; the docs step rewrote the body for them.
        result.url = /https:\/\/\S+/.exec(err)?.[0];
        sh('gh', ['pr', 'edit', branch, '--body-file', bodyFile], cwd);
        result.updated = true;
        return result;
      }
      if (cmd === 'gh' && /sha can't be blank|No commits between/i.test(err)) {
        throw new Error(`GitHub does not see ${branch} or ${target} to compare (${err.split('\n').at(-1)}). Check both are on GitHub: git ls-remote --heads origin ${branch} ${target}; a base that only exists locally needs pushing, or the task belongs on another base`);
      }
      throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${err.split('\n').slice(-3).join(' ')}`);
    }
    if (cmd === 'gh' && !existing) result.url = /https:\/\/\S+/.exec(r.stdout)?.[0];
  }
  return result;
}

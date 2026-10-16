// Role Router — the PR after it opens: open it automatically, turn feedback into rework, review it.
//
//   autoOpen(root, id)       a task passed (docs done): push and open its PR, or update the open one
//   intakeFeedback(root)     CI failing on the PR's head, a "changes requested" review, or a /rework
//                            comment → the task goes back to gaps_found with that feedback as findings
//   reviewPr(root, …)        a fresh review of the real PR diff on another account; one comment on
//                            the PR, and rework when it finds blockers
//
// Per task:  .role-router/runs/<ID>/pr-feedback.md   feedback the next Builder pass must address
//            .role-router/runs/<ID>/pr-state.json    { handledSha, handledAt, rounds }: no feedback is
//                                                    acted on twice, and rework rounds are bounded

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadBoard, setStatus } from './board.mjs';
import { PR, loadConfig } from './config.mjs';
import { ensureEscalation } from './escalations.mjs';
import { defaultFanProfiles, fan as realFan } from './fan.mjs';
import { baseBranch, openPr, taskBranch, worktreeDir } from './pr.mjs';
import { ensureStateDir, lastAccountFor, repoRootFor } from './runs.mjs';

export const REVIEW_MARK = '<!-- role-router:pr-review -->';

const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const runDir = (root, id) => path.join(repoRootFor(root), '.role-router', 'runs', id);
export const feedbackPath = (root, id) => path.join(runDir(root, id), 'pr-feedback.md');
const statePath = (root, id) => path.join(runDir(root, id), 'pr-state.json');

export function prSettings() {
  try { return loadConfig().pr; } catch { return { ...PR }; }
}

/** Only GitHub origins: elsewhere gh can only fail, slowly. */
export function isGitHub(root, run = sh) {
  const origin = run('git', ['remote', 'get-url', 'origin'], root);
  return origin.status === 0 && /github\.com[:/]/.test(origin.stdout);
}

export function readPrState(root, id) {
  try { return JSON.parse(readFileSync(statePath(root, id), 'utf8')); } catch { return { rounds: 0 }; }
}
function writePrState(root, id, state) {
  mkdirSync(runDir(root, id), { recursive: true });
  writeFileSync(statePath(root, id), JSON.stringify(state, null, 2) + '\n');
}

// ---------------------------------------------------------------------------------------------
// Reading PRs

const checksOf = (rollup) => {
  const c = (rollup ?? []).map((x) => x.conclusion || x.state || '');
  return c.some((s) => /FAIL|ERROR|CANCEL|TIMED_OUT|ACTION_REQUIRED/i.test(s)) ? 'failing'
    : c.some((s) => /PEND|QUEUE|IN_PROGRESS|EXPECTED|^$/i.test(s)) ? 'pending' : c.length ? 'green' : 'none';
};

const prCache = new Map(); // root → { at, prs }

/** task id → { state, url, number, headSha, checks, review, reviews } for task/<ID> PRs, or null when gh cannot answer. */
export function pullRequests(root, { run = sh, ttlMs = 60_000 } = {}) {
  const cached = prCache.get(root);
  if (cached && Date.now() - cached.at < ttlMs) return cached.prs;
  let prs = null;
  if (isGitHub(root, run)) {
    const r = run('gh', ['pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'headRefName,headRefOid,state,url,number,reviewDecision,latestReviews,statusCheckRollup'], root);
    if (r.status === 0) {
      try {
        prs = new Map();
        for (const p of JSON.parse(r.stdout)) {
          const id = /^task\/((?:TASK|FIX|QUICK)-[^-/\s]+)/.exec(p.headRefName ?? '')?.[1];
          if (!id || prs.get(id)?.state === 'OPEN') continue;
          prs.set(id, {
            state: p.state, url: p.url, number: p.number, headSha: p.headRefOid, review: p.reviewDecision || null,
            reviews: (p.latestReviews ?? []).map((v) => ({ state: v.state, at: v.submittedAt, author: v.author?.login })),
            checks: checksOf(p.statusCheckRollup),
          });
        }
      } catch { prs = null; }
    }
  }
  prCache.set(root, { at: Date.now(), prs });
  return prs;
}

/**
 * Why this open PR needs rework now, or null. Feedback already handled never counts twice: CI by
 * the head commit it failed on, reviews and /rework comments by time.
 * @param {{ checks: string, headSha: string, reviews: Array<{state: string, at: string}> }} pr
 * @param {{ handledSha?: string, handledAt?: string }} state
 * @param {Array<{ body: string, at: string }>} [comments]   only needed for /rework
 */
export function reworkReason(pr, state, comments = []) {
  const after = (at) => !state.handledAt || new Date(at) > new Date(state.handledAt);
  if (pr.checks === 'failing' && pr.headSha && pr.headSha !== state.handledSha) return 'CI failing';
  if (pr.reviews?.some((v) => v.state === 'CHANGES_REQUESTED' && after(v.at))) return 'changes requested';
  if (comments.some((c) => /^\s*\/rework\b/im.test(c.body) && after(c.at))) return '/rework comment';
  return null;
}

/** Everything a Builder needs to address the PR's feedback, as Markdown. */
export function collectFeedback(root, pr, state, run = sh) {
  const after = (at) => !state.handledAt || new Date(at) > new Date(state.handledAt);
  const parts = [`# Feedback on PR #${pr.number} (${pr.url})`];
  const view = run('gh', ['pr', 'view', String(pr.number), '--json', 'reviews,comments,statusCheckRollup'], root);
  let data = {};
  try { data = JSON.parse(view.stdout); } catch { /* partial feedback is still feedback */ }
  const reviews = (data.reviews ?? []).filter((v) => v.body?.trim() && after(v.submittedAt) && !v.body.includes(REVIEW_MARK));
  const comments = (data.comments ?? []).filter((c) => c.body?.trim() && after(c.createdAt) && !c.body.includes(REVIEW_MARK));
  if (reviews.length || comments.length) {
    parts.push('## Reviews and comments');
    for (const v of reviews) parts.push(`- **${v.author?.login ?? '?'}** (${v.state}): ${v.body.trim()}`);
    for (const c of comments) parts.push(`- **${c.author?.login ?? '?'}**: ${c.body.trim()}`);
  }
  const inline = run('gh', ['api', `repos/{owner}/{repo}/pulls/${pr.number}/comments`, '--paginate'], root);
  try {
    const list = JSON.parse(inline.stdout).filter((c) => after(c.created_at));
    if (list.length) {
      parts.push('## Inline comments');
      for (const c of list) parts.push(`- \`${c.path}:${c.line ?? c.original_line ?? '?'}\` **${c.user?.login ?? '?'}**: ${c.body.trim()}`);
    }
  } catch { /* no inline comments */ }
  const failed = (data.statusCheckRollup ?? []).filter((c) => /FAIL|ERROR|CANCEL|TIMED_OUT/i.test(c.conclusion || c.state || ''));
  if (failed.length) {
    parts.push('## Failing checks');
    for (const c of failed) {
      parts.push(`### ${c.name ?? c.context}${c.detailsUrl ? ` (${c.detailsUrl})` : ''}`);
      const runId = /\/actions\/runs\/(\d+)/.exec(c.detailsUrl ?? '')?.[1];
      if (runId) {
        const log = run('gh', ['run', 'view', runId, '--log-failed'], root);
        const tail = (log.stdout ?? '').split('\n').slice(-150).join('\n').trim();
        if (tail) parts.push('```\n' + tail + '\n```');
      }
    }
  }
  return { markdown: parts.join('\n\n') + '\n', comments: comments.map((c) => ({ body: c.body, at: c.createdAt })) };
}

/**
 * Send a task back for rework with this feedback, or to the inbox once the rounds are used up.
 * @returns {'rework' | 'parked'}
 */
export function queueRework(root, id, { markdown, reason, pr, headSha, fixRounds = prSettings().fixRounds }) {
  const main = repoRootFor(root);
  const state = readPrState(main, id);
  const rounds = (state.rounds ?? 0) + 1;
  writePrState(main, id, { handledSha: headSha ?? state.handledSha, handledAt: new Date().toISOString(), rounds });
  ensureStateDir(main);
  writeFileSync(feedbackPath(main, id), markdown);
  if (rounds > fixRounds) {
    setStatus(main, id, 'human_needed');
    ensureEscalation(main, id, {
      type: 'review-gaps',
      question: `PR #${pr?.number ?? '?'} for ${id} still has feedback (${reason}) after ${fixRounds} fix round(s): fix it by hand, or decide what to drop`,
      detail: `1. Fix it yourself on branch task/${id}, then role-router sync\n2. Allow another round: role-router resolve ${id} --note "one more round", then role-router launch ${id}\n\n${markdown.slice(0, 2000)}`,
    });
    return 'parked';
  }
  setStatus(main, id, 'gaps_found');
  return 'rework';
}

/** PR feedback → rework, for every passed task with an open PR (called by sync). */
export function intakeFeedback(root, { run = sh, prs = (r) => pullRequests(r, { run, ttlMs: 0 }) } = {}) {
  const main = repoRootFor(root);
  const board = loadBoard(main);
  const out = { rework: [], parked: [] };
  if (!board?.list.some((t) => t.status === 'passed')) return out;
  const map = prs(main);
  if (!map) return out;
  for (const t of board.list.filter((x) => x.status === 'passed')) {
    const pr = map.get(t.id);
    if (pr?.state !== 'OPEN') continue;
    const state = readPrState(main, t.id);
    let reason = reworkReason(pr, state);
    let feedback = null;
    if (!reason) { // /rework comments need the comment bodies; fetch them only when nothing else triggered
      feedback = collectFeedback(main, pr, state, run);
      reason = reworkReason(pr, state, feedback.comments);
      if (!reason) continue;
    }
    feedback ??= collectFeedback(main, pr, state, run);
    const markdown = `Reason: ${reason}\n\n${feedback.markdown}`;
    const r = queueRework(main, t.id, { markdown, reason, pr, headSha: pr.headSha });
    out[r === 'rework' ? 'rework' : 'parked'].push(`${t.id} (${reason})`);
  }
  return out;
}

/** The prompt section for a task with PR feedback waiting (Builder, Escalation, Review). */
export function feedbackPrompt(root, id) {
  const file = feedbackPath(root, id);
  if (!existsSync(file)) return '';
  return `## Feedback on the open PR (binding)\nThis task's PR received feedback: ${file}. Address every item on the task branch (fix failing checks at the root, answer review comments in code). The Reviewer checks each item was addressed. Do not open a new PR: role-router pushes the branch and the open PR updates.`;
}

// ---------------------------------------------------------------------------------------------
// Opening

/**
 * A task passed: push it and open its PR (or update the open one). Never throws.
 * @returns {{ url?: string, skipped?: string, error?: string }}
 */
export function autoOpen(root, id, { settings = prSettings(), run = sh, open = openPr } = {}) {
  if (!settings.auto) return { skipped: 'pr.auto is off' };
  const main = repoRootFor(root);
  if (!isGitHub(main, run)) return { skipped: 'not a GitHub repo' };
  const task = loadBoard(main)?.byId.get(id);
  if (!task) return { skipped: 'unknown task' };
  try {
    const r = open(main, task, { draft: settings.draft, sh: run });
    // The feedback this pass addressed is history now.
    try { renameSync(feedbackPath(main, id), `${feedbackPath(main, id)}.${Date.now()}.addressed`); } catch { /* none */ }
    return { url: r.url };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------------------------------------
// Reviewing

const SEVERITY = ['approve', 'comment', 'request_changes'];

export function reviewVerdict(text) {
  const m = [...(text ?? '').matchAll(/verdict\W*\s*(approve|comment|request[_ ]changes)\b/gi)].at(-1);
  return m ? m[1].toLowerCase().replace(' ', '_') : null;
}

const REVIEW_PROMPT = ({ title, number, url, base, head, diffFile, body }) => `Review pull request ${number ? `#${number} ` : ''}"${title}"${url ? ` (${url})` : ''}: ${head} into ${base}.

The complete diff is in ${diffFile}. Read it in full. The repository is your working directory; read surrounding code where the diff alone does not show whether a change is correct (\`git show ${head}:<path>\` for a file as of the PR).

Look for: correctness bugs and edge cases, security problems, broken or missing tests for changed behaviour, API or data-shape changes that callers do not handle, and anything the description claims that the diff does not do. Skip style nits a formatter or linter would catch. Every finding must point at a file and line in the diff and say what goes wrong, in which case.

${body ? `The PR description:\n\n${body}\n\n` : ''}Answer in this shape, nothing before it:

## Findings
- [blocker|major|minor] path:line: what is wrong, when it happens, the fix
(write "none" when there are none)

## Summary
<two sentences>

verdict: approve | comment | request_changes
(request_changes only for blocker or major findings)`;

/** The profiles to review with: top tier of accounts that did not build or review the task. */
export function reviewProfiles(root, id, config, { panel = false } = {}) {
  const all = defaultFanProfiles(config);
  const used = id ? [lastAccountFor(root, id, ['builder', 'escalation']), lastAccountFor(root, id, ['review'])].filter(Boolean) : [];
  const fresh = all.filter((p) => !used.includes(config.profiles[p].account));
  const pool = fresh.length ? fresh : all;
  return panel ? pool : pool.slice(0, 1);
}

/**
 * Review a PR (a task's, or any PR number on GitHub; locally, the task branch against its base).
 * @returns {Promise<{ verdict: string, comment: string, commentFile: string, posted?: string, rework?: string, lanes: object[] }>}
 */
export async function reviewPr(root, { id, number, panel = false, post = true, rework = true, run = sh, fan = realFan, config = loadConfig(), timeoutMinutes = 20 }) {
  const main = repoRootFor(root);
  const github = isGitHub(main, run);
  let pr = { number };
  const branch = id ? taskBranch(main, id) : null;
  if (github) {
    const v = run('gh', ['pr', 'view', number ? String(number) : branch ?? '', '--json', 'number,url,title,body,baseRefName,headRefName,headRefOid'], main);
    if (v.status !== 0) throw new Error(`no PR found for ${id ?? `#${number}`}: ${(v.stderr || '').trim().split('\n').at(-1)}${id ? ` (open it: role-router pr ${id})` : ''}`);
    const p = JSON.parse(v.stdout);
    pr = { number: p.number, url: p.url, title: p.title, body: p.body, base: p.baseRefName, head: p.headRefName, headSha: p.headRefOid };
    id ??= /^task\/((?:TASK|FIX|QUICK)-[^-/\s]+)/.exec(pr.head)?.[1];
    run('git', ['fetch', '-q', 'origin', pr.head, pr.base], main);
  } else {
    if (!branch) throw new Error(number ? 'a PR number needs a GitHub repo' : `no branch for ${id}`);
    const task = loadBoard(main)?.byId.get(id);
    pr = { title: `${id}: ${task?.title ?? ''}`, base: baseBranch(main, id, branch), head: branch };
  }
  const key = id ?? `PR-${pr.number}`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dir = path.join(ensureStateDir(main), 'runs', key, `pr-review-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const diff = github ? run('gh', ['pr', 'diff', String(pr.number)], main) : run('git', ['diff', `${pr.base}...${pr.head}`], main);
  if (diff.status !== 0 || !diff.stdout.trim()) throw new Error(`could not read the diff: ${(diff.stderr || 'empty diff').trim().split('\n').at(-1)}`);
  const diffFile = path.join(dir, 'diff.patch');
  writeFileSync(diffFile, diff.stdout);
  const head = github ? (pr.headSha ?? `origin/${pr.head}`) : pr.head;

  const profiles = reviewProfiles(main, id, config, { panel });
  const wt = id && existsSync(path.join(worktreeDir(main, id), '.git')) ? worktreeDir(main, id) : main;
  const { lanes } = await fan({ prompt: REVIEW_PROMPT({ ...pr, head, diffFile }), profiles, cwd: wt, out: dir, timeoutMinutes });
  // An empty answer is a reviewer that did not finish, not a verdict.
  for (const l of lanes) if (l.status === 'ok' && !readFileSync(l.answer, 'utf8').trim()) Object.assign(l, { status: 'crashed', message: 'empty answer' });
  const answers = lanes.filter((l) => l.status === 'ok').map((l) => ({ profile: l.profile, text: readFileSync(l.answer, 'utf8').trim() }));
  const missing = lanes.filter((l) => l.status !== 'ok').map((l) => `${l.profile} ${l.status}${l.message ? ` (${l.message})` : ''}`);
  if (!answers.length) throw new Error(`no reviewer finished: ${missing.join(', ')}`);
  const verdicts = answers.map((a) => ({ ...a, verdict: reviewVerdict(a.text) ?? 'comment' }));
  const verdict = verdicts.reduce((w, a) => (SEVERITY.indexOf(a.verdict) > SEVERITY.indexOf(w) ? a.verdict : w), 'approve');

  const comment = [
    REVIEW_MARK,
    `### role-router review: ${verdict.replace('_', ' ')}`,
    `${verdicts.length > 1 ? verdicts.map((a) => `${a.profile}: ${a.verdict.replace('_', ' ')}`).join(' · ') : `Reviewed by ${verdicts[0].profile}.`}${missing.length ? ` (no answer: ${missing.join(', ')})` : ''}\n`,
    ...(verdicts.length === 1 ? [verdicts[0].text] : verdicts.map((a) => `<details${a.verdict === verdict ? ' open' : ''}><summary>${a.profile}: ${a.verdict.replace('_', ' ')}</summary>\n\n${a.text}\n\n</details>`)),
  ].join('\n');
  const commentFile = path.join(dir, 'comment.md');
  writeFileSync(commentFile, comment + '\n');
  const result = { verdict, comment, commentFile, lanes, missing };

  if (post && github) {
    const c = run('gh', ['pr', 'comment', String(pr.number), '--body-file', commentFile], main);
    result.posted = c.status === 0 ? (/https:\/\/\S+/.exec(c.stdout)?.[0] ?? pr.url) : undefined;
    if (c.status !== 0) result.postError = (c.stderr || '').trim().split('\n').at(-1);
  }
  const task = id ? loadBoard(main)?.byId.get(id) : null;
  if (rework && verdict === 'request_changes' && task?.status === 'passed') {
    result.rework = queueRework(main, id, { markdown: `Reason: role-router PR review asked for changes\n\n# Feedback on ${pr.number ? `PR #${pr.number}` : `branch ${pr.head}`}\n\n${comment.replace(REVIEW_MARK, '').trim()}\n`, reason: 'review asked for changes', pr, headSha: pr.headSha });
  }
  return result;
}

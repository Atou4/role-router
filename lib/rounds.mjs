// Role Router — review rounds: findings handed both ways, and which rounds count.
//
// A review that returns gaps_found tags each Must-fix ([MF1], [MF2], …). The next Builder pass gets
// those findings and answers each one in .role-router/runs/<ID>/review-response-<run>.md (fixed in
// <commit>, or disputed with evidence). The next reviewer gets the findings and the answers, closes
// what is settled, and keeps what is not as [MFn kept]. The loop then counts only rounds that made
// no progress against the round limit: a review with new findings only earns a repair pass, a kept
// finding counts, and a kept finding the Builder disputed goes to a human with both sides.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRootFor } from './runs.mjs';

const runDir = (root, task) => path.join(repoRootFor(root), '.role-router', 'runs', task);
export const responsePath = (root, task, reviewRun) => path.join(runDir(root, task), `review-response-${reviewRun}.md`);

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

/** Ok role runs on a task, oldest first: { run: '004-openai-lite', operation, summary }. */
function roleRuns(root, task) {
  const dir = runDir(root, task);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d+-.*\.json$/.test(f)).sort().flatMap((f) => {
    try {
      const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      const operation = r.operation ?? r.role;
      if (r.result?.kind !== 'ok' || !['builder', 'escalation', 'review', 'docs'].includes(operation)) return [];
      return [{ run: f.replace(/\.json$/, ''), operation, summary: r.result.summary ?? '' }];
    } catch { return []; }
  });
}

/** The newest review that found gaps, if nothing passed since: { run, summary, rebuilt }. */
export function openReview(root, task) {
  const runs = roleRuns(root, task);
  const i = runs.findLastIndex((r) => r.operation === 'review' || r.operation === 'docs');
  if (i < 0 || runs[i].operation !== 'review' || verdictOf(runs[i].summary) !== 'gaps_found') return null;
  return { run: runs[i].run, summary: runs[i].summary, rebuilt: runs.slice(i + 1).some((r) => ['builder', 'escalation'].includes(r.operation)) };
}

/** Tags in a review: new findings ([MF1]) and kept ones ([MF1 kept]). */
export function findingTags(summary) {
  const fresh = new Set();
  const kept = new Set();
  for (const m of (summary ?? '').matchAll(/\[MF\s*(\d+)(\s+kept)?\]/gi)) (m[2] ? kept : fresh).add(Number(m[1]));
  for (const n of kept) fresh.delete(n);
  return { fresh: [...fresh], kept: [...kept] };
}

/** Findings the Builder disputed in its answer: number → the line. */
export function disputed(response) {
  const out = new Map();
  for (const line of (response ?? '').split('\n')) {
    const m = /\[MF\s*(\d+)\]\s*[*_]*\s*disputed\b/i.exec(line);
    if (m) out.set(Number(m[1]), line.replace(/^\s*[-*]\s*/, '').trim());
  }
  return out;
}

const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };

/**
 * How a gaps_found review round went, given the review it re-checked (if any).
 * @returns {{ counts: boolean, kept: number[], dispute: Array<{ tag: number, builder: string }> }}
 *   counts: the round goes against the round limit (a kept finding, or untagged findings that
 *   cannot be told apart); dispute: kept findings the Builder had disputed.
 */
export function roundOutcome(root, task, summary, previous) {
  const { fresh, kept } = findingTags(summary);
  const answers = previous ? disputed(readText(responsePath(root, task, previous.run))) : new Map();
  const dispute = kept.filter((n) => answers.has(n)).map((n) => ({ tag: n, builder: answers.get(n) }));
  return { counts: kept.length > 0 || fresh.length === 0, kept, dispute };
}

/** The Builder's (and Escalation's) section: the findings to fix, and where to answer them. */
export function findingsPrompt(root, task) {
  const open = openReview(root, task);
  if (!open) return '';
  const file = responsePath(root, task, open.run);
  return `## Review findings to address (binding)\nThe last review (run ${open.run}) returned gaps_found:\n\n${open.summary.trim().slice(-6000)}\n\nFix every Must-fix. Then write ${file}, one line per Must-fix with the reviewer's tag:\n- [MF1] fixed in <commit>: <what changed>\n- [MF2] disputed: <why it is not a defect: the file:line that already does it, or the test that proves it>\nDispute only what you can show; a disputed finding the next reviewer keeps goes to a human with both sides. A finding the reviewer could not check because its own environment failed (a test database it could not start) is not a code defect: say so, rerun the gates yourself, and record the evidence for the commit you hand over.`;
}

/** The reviewer's section: what the last round found and how the Builder answered. */
export function previousRoundPrompt(root, task) {
  const open = openReview(root, task);
  if (!open?.rebuilt) return '';
  const answer = readText(responsePath(root, task, open.run));
  return `## The previous review round (check these first)\nThe last review (run ${open.run}) found:\n\n${open.summary.trim().slice(-5000)}\n\nThe Builder answered${answer ? ` (${responsePath(root, task, open.run)}):\n\n${answer.trim().slice(0, 4000)}` : ': it wrote no answer.'}\n\nCheck each earlier Must-fix first. One that is now fixed, or whose dispute holds (the code already does it), is closed: do not list it again. One still open goes under Must-fix as \`[MFn kept] <why the fix or the dispute does not settle it>\`, with its original number. New findings take new numbers.`;
}

/** "Unverified by reviewer:" lines from the review that passed the task, for the PR body. */
export function unverifiedNotes(root, task) {
  const review = roleRuns(root, task).filter((r) => r.operation === 'review').at(-1);
  return (review?.summary ?? '').split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').trim()).filter((l) => /^unverified by reviewer\s*:/i.test(l));
}

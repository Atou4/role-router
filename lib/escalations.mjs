// Role Router — escalations: stops that need a human, in one inbox with a one-command answer.
//
//   <repo>/.role-router/escalations/<TASK>.md               the question (written by the agent, or by
//                                                            role-router from the stop when the agent did not)
//   <repo>/.role-router/escalations/<TASK>.decision.json    your answer (role-router resolve)
//
// The agent's block:
//   ### Escalation
//   - type: design | product | environment | stuck-build | review-gaps
//   - question: <one line>
//   - options:
//     1. <option>
//     2. <option>
//   - recommendation: <option number or text>
//   - affects: Repo:TASK-008, TASK-102
//
// Once resolved, the decision is added to every later prompt for that task.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadBoard } from './board.mjs';
import { knownRepos } from './repos.mjs';
import { ensureStateDir, repoRootFor } from './runs.mjs';

export const ESCALATION_TYPES = ['design', 'product', 'environment', 'stuck-build', 'review-gaps', 'other'];

const dir = (repoRoot) => path.join(repoRootFor(repoRoot), '.role-router', 'escalations');
export const escalationPath = (repoRoot, task) => path.join(dir(repoRoot), `${task}.md`);
const decisionPath = (repoRoot, task) => path.join(dir(repoRoot), `${task}.decision.json`);

/**
 * Parse an `### Escalation` block (tolerant of markdown emphasis and indentation).
 * @returns {{ type: string, question: string, options: string[], recommendation?: string, affects: string[] } | null}
 */
export function parseEscalation(text) {
  const start = (text ?? '').search(/^#{2,4}\s*Escalation\b/im);
  const body = start === -1 ? text ?? '' : text.slice(start);
  // [ \t]* (not \s*): an empty field must not swallow the next line.
  const field = (name) => new RegExp(`^[ \\t]*[-*][ \\t]*\\**${name}\\**[ \\t]*:[ \\t]*(.*)$`, 'im').exec(body)?.[1]?.replace(/[*`]/g, '').trim();
  const question = field('question');
  if (!question) return null;
  const optionsAt = body.search(/^\s*[-*]\s*\**options\**\s*:/im);
  const options = [];
  if (optionsAt !== -1) {
    for (const line of body.slice(optionsAt).split('\n').slice(1)) {
      const m = /^\s+(?:\d+[.)]|[-*])\s+(.*)$/.exec(line);
      if (m) options.push(m[1].replace(/[*`]/g, '').trim());
      else if (line.trim()) break;
    }
  }
  const type = (field('type') ?? 'other').toLowerCase();
  return {
    type: ESCALATION_TYPES.includes(type) ? type : 'other',
    question,
    options,
    recommendation: field('recommendation') || undefined,
    affects: (field('affects') ?? '').split(/[,\s]+/).map((s) => s.trim()).filter((s) => /(?:TASK|FIX|QUICK)-/.test(s)),
  };
}

/** Write an escalation on the agent's behalf (it stopped without one). Keeps an agent-written one. */
export function ensureEscalation(repoRoot, task, { type, question, detail }) {
  const file = escalationPath(repoRoot, task);
  if (existsSync(file) && parseEscalation(readFileSync(file, 'utf8')) && !isResolved(repoRoot, task)) return false;
  // The agent often lists the choices as a numbered list in prose: use the first one as options.
  const options = [];
  for (const line of (detail ?? '').split('\n')) {
    const m = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (m && Number(m[1]) === options.length + 1) options.push(m[2].replace(/[*`]/g, '').trim());
    else if (options.length && line.trim() && !/^\s{2,}/.test(line)) break;
  }
  ensureStateDir(repoRootFor(repoRoot));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `### Escalation
- type: ${type}
- question: ${question.replace(/\s+/g, ' ').trim()}
- options:
${options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}
- recommendation:
- affects:

(Written by role-router from the stop; the agent did not raise a structured escalation.)

${detail ? `#### Last words of the agent\n${detail.trim()}\n` : ''}`);
  try { renameSync(decisionPath(repoRoot, task), `${decisionPath(repoRoot, task)}.old`); } catch { /* no earlier decision */ }
  return true;
}

export function isResolved(repoRoot, task) {
  return existsSync(decisionPath(repoRoot, task));
}

export function readDecision(repoRoot, task) {
  try { return JSON.parse(readFileSync(decisionPath(repoRoot, task), 'utf8')); } catch { return null; }
}

/** Tasks that wait on `task`, in this repo and (via `Repo:TASK` dependencies) in every known repo. */
export function blockedBy(repoRoot, task) {
  const main = repoRootFor(repoRoot);
  const name = path.basename(main);
  const out = [];
  for (const r of new Set([main, ...knownRepos().map((k) => k.root)])) {
    const board = loadBoard(r);
    for (const t of board?.list ?? []) {
      const local = r === main && t.depends.includes(task);
      const remote = t.depends.includes(`${name}:${task}`);
      if (local || remote) out.push(r === main ? t.id : `${path.basename(r)}:${t.id}`);
    }
  }
  return out;
}

/**
 * Tasks already waiting on a human but with no escalation filed (they stopped before escalations
 * existed, or a status was set by hand): file one from their last run record so nothing is invisible.
 */
export function backfill(roots = knownRepos().map((r) => r.root)) {
  let filed = 0;
  for (const root of new Set(roots.map((r) => repoRootFor(r)))) {
    for (const t of loadBoard(root)?.list ?? []) {
      if (t.status !== 'human_needed' || existsSync(escalationPath(root, t.id))) continue;
      const runs = path.join(root, '.role-router', 'runs', t.id);
      let said = '';
      try {
        const last = readdirSync(runs).filter((f) => /^\d+-.*\.json$/.test(f)).sort().at(-1);
        const r = JSON.parse(readFileSync(path.join(runs, last), 'utf8'));
        said = r.result?.summary ?? r.result?.message ?? '';
      } catch { /* no runs */ }
      ensureEscalation(root, t.id, { type: 'design', question: `${t.id} is waiting on a human decision (see the agent's last words below)`, detail: said.slice(-2500) });
      filed++;
    }
  }
  return filed;
}

/** Open (unresolved) escalations across the given repos, oldest first. */
export function listEscalations(roots = knownRepos().map((r) => r.root)) {
  const out = [];
  for (const root of new Set(roots.map((r) => repoRootFor(r)))) {
    if (!existsSync(dir(root))) continue;
    for (const f of readdirSync(dir(root)).filter((x) => /^[A-Z]+-[^.]+\.md$/.test(x)).sort()) {
      const task = f.slice(0, -3);
      if (isResolved(root, task)) continue;
      const parsed = parseEscalation(readFileSync(path.join(dir(root), f), 'utf8'));
      if (!parsed) continue;
      out.push({ repoRoot: root, repo: path.basename(root), task, ...parsed, blocks: blockedBy(root, task) });
    }
  }
  return out;
}

/** A task that passed has nothing open: keep its escalation and decision only as history. */
export function archiveEscalation(repoRoot, task) {
  for (const f of [escalationPath(repoRoot, task), decisionPath(repoRoot, task)]) {
    try { renameSync(f, `${f}.done`); } catch { /* nothing to archive */ }
  }
}

/** Record your answer. `option` is 1-based. */
export function recordDecision(repoRoot, task, { option, note }) {
  const file = escalationPath(repoRoot, task);
  const esc = existsSync(file) ? parseEscalation(readFileSync(file, 'utf8')) : null;
  if (!esc) throw new Error(`no open escalation for ${task}`);
  if (option !== undefined && !esc.options[option - 1]) throw new Error(`${task} has ${esc.options.length} option(s); --option ${option} does not exist`);
  if (option === undefined && !note) throw new Error('give --option <n> or --note "<your decision>"');
  const decision = {
    decidedAt: new Date().toISOString(), type: esc.type, question: esc.question, affects: esc.affects,
    ...(option !== undefined && { option, optionText: esc.options[option - 1] }), ...(note && { note }),
  };
  writeFileSync(decisionPath(repoRoot, task), JSON.stringify(decision, null, 2) + '\n');
  return decision;
}

/** One paragraph for agent prompts: the human decision that settles this task's escalation. */
export function decisionPrompt(repoRoot, task) {
  const d = readDecision(repoRoot, task);
  if (!d) return '';
  const answer = [d.optionText && `option ${d.option}: ${d.optionText}`, d.note].filter(Boolean).join('. ');
  return `## Decision from the human (binding)\nThis task was escalated with the question "${d.question}". The human decided: ${answer}. Follow this decision; do not reopen it.`;
}

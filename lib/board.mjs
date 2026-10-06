// Role Router — the task board (library form of what scripts/board.mjs exposes).
//
// Two kinds of task share one board:
// - Planned tasks (`TASK-…`): sections of PLAN.md written by the Architect and committed.
// - Quick tasks (`FIX-…`, `QUICK-…`): one file each in `.role-router/tasks/` at the main
//   checkout, created by `role-router fix|quick` from a one-line description. Never committed.
// Both use the same section format: `## <ID> — <title>`, then `status:` / `depends:` lines
// above the first `###` subsection (`status:` is the *initial* status).
// Live status is runtime state in `.role-router/board.json` at the main checkout, outside git,
// so every branch and worktree sees the same board and no status change dirties a working tree.
// Status contract: see docs/task-spec.md.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureStateDir, repoRootFor } from './runs.mjs';

export const STATUSES = ['planned', 'building', 'review', 'passed', 'gaps_found', 'human_needed', 'done'];
export const QUICK_KINDS = { fix: 'FIX', quick: 'QUICK' };
const HEADING = /^##\s+((?:TASK|FIX|QUICK)-\S+)(?:\s*[—\-:]\s*(.*))?\s*$/;

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {string[]} depends
 * @property {string} [kind]     'fix' | 'quick' for quick tasks
 * @property {string} file       where the task's spec lives
 * @property {string[]} lines    the task's own section
 */

export const planPath = (root) => path.join(root, 'PLAN.md');
export const quickTasksDir = (root) => path.join(repoRootFor(root), '.role-router', 'tasks');
const statePath = (root) => path.join(repoRootFor(root), '.role-router', 'board.json');

function readState(root) {
  try { return JSON.parse(readFileSync(statePath(root), 'utf8')); } catch { return {}; }
}

/** Every `## <ID>` section in one file. */
function parseSections(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const heads = [];
  lines.forEach((line, i) => {
    const m = HEADING.exec(line);
    if (m) heads.push({ id: m[1], title: (m[2] || '').trim(), start: i });
  });
  return heads.map((h, k) => {
    const block = lines.slice(h.start, k + 1 < heads.length ? heads[k + 1].start : lines.length);
    const meta = (key) => {
      const re = new RegExp(`^\\s*[-*]?\\s*${key}:\\s*(.+?)\\s*$`, 'i');
      for (const l of block) {
        if (/^###\s/.test(l)) break;
        const m = re.exec(l);
        if (m) return m[1];
      }
      return null;
    };
    return {
      id: h.id, title: h.title, file, lines: block,
      status: (meta('status') || 'planned').toLowerCase(),
      depends: (meta('depends') || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
      ...(meta('kind') && { kind: meta('kind').toLowerCase() }),
    };
  });
}

/** PLAN.md tasks plus quick tasks, with live statuses applied; null when there are none. */
export function loadBoard(root) {
  const files = [];
  if (existsSync(planPath(root))) files.push(planPath(root));
  const quick = quickTasksDir(root);
  if (existsSync(quick)) files.push(...readdirSync(quick).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(quick, f)));
  if (files.length === 0) return null;
  /** @type {Task[]} */
  const list = files.flatMap(parseSections);
  const live = readState(root);
  for (const t of list) if (live[t.id]?.status) t.status = live[t.id].status;
  return { list, byId: new Map(list.map((t) => [t.id, t])) };
}

/** Buildable = `planned` with every dependency `done`. */
export const isBuildable = (task, byId) => task.status === 'planned' && task.depends.every((d) => byId.get(d)?.status === 'done');

/** Record a task's live status in the shared board state (never edits a spec file). */
export function setStatus(root, id, status) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown status "${status}". Use one of: ${STATUSES.join(', ')}`);
  const board = loadBoard(root);
  if (!board?.byId.get(id)) throw new Error(`Unknown task "${id}".`);
  ensureStateDir(repoRootFor(root));
  const state = readState(root);
  state[id] = { status, updatedAt: new Date().toISOString() };
  const file = statePath(root);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Acceptance criteria of a task: ticked `[x]` items are verified, unticked are still open. */
export function acceptance(root, id) {
  const task = loadBoard(root)?.byId.get(id);
  if (!task) return null;
  const done = [];
  const open = [];
  let inSection = false;
  for (const line of task.lines) {
    if (/^###\s/.test(line)) inSection = /acceptance criteria/i.test(line);
    else if (inSection) {
      const m = /^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/.exec(line);
      if (m) (m[1] === ' ' ? open : done).push(m[2].trim());
    }
  }
  return { done, open };
}

const CRITERIA = {
  fix: [
    'the reported behaviour is reproduced by a test that fails before the fix',
    'that test passes after the fix, and the root cause is written under Notes',
    "the repo's full test suite passes",
  ],
  quick: [
    'the requested behaviour exists and a test covers it',
    "the repo's full test suite passes",
  ],
};

/**
 * Create a quick task from a one-line description: `.role-router/tasks/<ID>.md`.
 * @param {string} root
 * @param {'fix' | 'quick'} kind
 * @param {string} request
 * @returns {Task}
 */
export function createQuickTask(root, kind, request) {
  const prefix = QUICK_KINDS[kind];
  if (!prefix) throw new Error(`unknown quick task kind "${kind}"`);
  if (!request?.trim()) throw new Error(`describe the ${kind === 'fix' ? 'bug' : 'change'} in quotes`);
  ensureStateDir(repoRootFor(root));
  const dir = quickTasksDir(root);
  mkdirSync(dir, { recursive: true });
  const taken = new Set(loadBoard(root)?.list.map((t) => t.id) ?? []);
  let n = 1;
  while (taken.has(`${prefix}-${String(n).padStart(3, '0')}`)) n++;
  const id = `${prefix}-${String(n).padStart(3, '0')}`;
  const oneLine = request.trim().replace(/\s+/g, ' ');
  const title = oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
  const file = path.join(dir, `${id}.md`);
  writeFileSync(file, `## ${id} — ${title}
- status: planned
- depends:
- kind: ${kind}
### Request
${request.trim()}
### Acceptance Criteria
${CRITERIA[kind].map((c) => `- [ ] ${c}`).join('\n')}
### Notes
(Builder: write what you understood${kind === 'fix' ? ', the reproduction and the root cause' : ' and the test seam you used'} here before changing code.)
`);
  return loadBoard(root).byId.get(id);
}

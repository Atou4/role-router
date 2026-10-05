// Role Router — PLAN.md task board (library form of what scripts/board.mjs exposes).
//
// PLAN.md is the spec: one level-2 section per task; `status:` and `depends:` are read only
// above the first `###` subsection, and `status:` there is the task's *initial* status.
// Live status is runtime state: it lives in `.role-router/board.json` at the main checkout,
// outside git, so every branch and worktree sees the same board and no status change ever
// dirties a working tree. Status contract: see docs/task-spec.md.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureStateDir, repoRootFor } from './runs.mjs';

export const STATUSES = ['planned', 'building', 'review', 'passed', 'gaps_found', 'human_needed', 'done'];

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {string[]} depends
 * @property {number} start   first line of the section
 * @property {number} end     one past the last line
 */

export const planPath = (root) => path.join(root, 'PLAN.md');
const statePath = (root) => path.join(repoRootFor(root), '.role-router', 'board.json');

function readState(root) {
  try { return JSON.parse(readFileSync(statePath(root), 'utf8')); } catch { return {}; }
}

/** Parse PLAN.md under `root`; null when there is none. */
export function loadBoard(root) {
  const file = planPath(root);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const heads = [];
  lines.forEach((line, i) => {
    const m = /^##\s+(TASK-\S+)(?:\s*[—\-:]\s*(.*))?\s*$/.exec(line);
    if (m) heads.push({ id: m[1], title: (m[2] || '').trim(), start: i });
  });
  /** @type {Task[]} */
  const list = heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].start : lines.length;
    const block = lines.slice(h.start, end);
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
      id: h.id, title: h.title, start: h.start, end,
      status: (meta('status') || 'planned').toLowerCase(),
      depends: (meta('depends') || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
    };
  });
  const live = readState(root);
  for (const t of list) if (live[t.id]?.status) t.status = live[t.id].status;
  return { file, lines, list, byId: new Map(list.map((t) => [t.id, t])) };
}

/** Buildable = `planned` with every dependency `done`. */
export const isBuildable = (task, byId) => task.status === 'planned' && task.depends.every((d) => byId.get(d)?.status === 'done');

/** Record a task's live status in the shared board state (never edits PLAN.md). */
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
  const board = loadBoard(root);
  const task = board?.byId.get(id);
  if (!task) return null;
  const done = [];
  const open = [];
  let inSection = false;
  for (const line of board.lines.slice(task.start, task.end)) {
    if (/^###\s/.test(line)) inSection = /acceptance criteria/i.test(line);
    else if (inSection) {
      const m = /^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/.exec(line);
      if (m) (m[1] === ' ' ? open : done).push(m[2].trim());
    }
  }
  return { done, open };
}

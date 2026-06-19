#!/usr/bin/env node

// Role Router — portable PLAN.md task driver.
//
// The generic backend for /next and /fan-out when a repo has no dedicated board
// (no `.agent-board/`). It is the source of truth for two questions the loop asks:
//   - what is the next buildable task?            (deps satisfied, status planned)
//   - what is the next buildable WAVE?            (all such tasks — for /fan-out)
// …and it owns the normalized status contract every Role command reads/writes.
//
//   node scripts/board.mjs next                 -> JSON of the next buildable task, or NONE
//   node scripts/board.mjs wave                 -> JSON array of buildable tasks (deps done)
//   node scripts/board.mjs list                 -> human summary
//   node scripts/board.mjs status <id>          -> prints the task's status
//   node scripts/board.mjs set-status <id> <s>  -> rewrites the task's status line
//
// PLAN.md format — one level-2 section per task, metadata lines under the heading:
//
//   ## TASK-003 — Add phone verification
//   - status: planned
//   - depends: TASK-001, TASK-002
//   ### Scope
//   ...
//
// Status contract (normalized — see docs/task-spec.md):
//   planned -> building -> review -> {passed | gaps_found | human_needed} -> done
//   "buildable" = status `planned` AND every `depends:` task is `done`.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const STATUSES = ['planned', 'building', 'review', 'passed', 'gaps_found', 'human_needed', 'done'];

function repoRoot() {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); }
  catch { return process.cwd(); }
}
const PLAN = path.join(repoRoot(), 'PLAN.md');

function readPlan() {
  if (!existsSync(PLAN)) {
    console.error(`No PLAN.md at ${PLAN}. Run /plan first (Architect, Vanilla Context).`);
    process.exit(1);
  }
  return readFileSync(PLAN, 'utf8');
}

// Parse PLAN.md into tasks. Each task owns the lines from its `## TASK-` heading
// up to (but not including) the next level-2 heading.
function parse(text) {
  const lines = text.split('\n');
  const heads = [];
  lines.forEach((line, i) => {
    const m = /^##\s+(TASK-\S+)(?:\s*[—\-:]\s*(.*))?\s*$/.exec(line);
    if (m) heads.push({ id: m[1], title: (m[2] || '').trim(), start: i });
  });

  return heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].start : lines.length;
    const block = lines.slice(h.start, end);
    const meta = (key) => {
      const re = new RegExp(`^\\s*[-*]?\\s*${key}:\\s*(.+?)\\s*$`, 'i');
      // only metadata above the first `### ` subsection counts
      for (const l of block) {
        if (/^###\s/.test(l)) break;
        const m = re.exec(l);
        if (m) return m[1];
      }
      return null;
    };
    const status = (meta('status') || 'planned').toLowerCase();
    const depends = (meta('depends') || '')
      .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    return { id: h.id, title: h.title, status, depends, start: h.start, end };
  });
}

function buildable(task, byId) {
  return task.status === 'planned' && task.depends.every((d) => byId.get(d)?.status === 'done');
}

function tasks() {
  const list = parse(readPlan());
  return { list, byId: new Map(list.map((t) => [t.id, t])) };
}

function emit(task) {
  if (!task) { console.log('NONE'); return; }
  console.log(JSON.stringify({
    id: task.id, title: task.title, depends: task.depends, branch: `task/${task.id}`,
  }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'next': {
    const { list, byId } = tasks();
    emit(list.find((t) => buildable(t, byId)) ?? null);
    break;
  }
  case 'wave': {
    const { list, byId } = tasks();
    const w = list.filter((t) => buildable(t, byId));
    console.log(JSON.stringify(w.map((t) => ({ id: t.id, title: t.title, depends: t.depends })), null, 2));
    break;
  }
  case 'list': {
    const { list, byId } = tasks();
    for (const t of list) {
      const flag = buildable(t, byId) ? 'BUILDABLE' : '         ';
      const dep = t.depends.join(',') || '-';
      console.log(`${flag}  ${t.id}  ${t.status.padEnd(12)}  depends=${dep}  ${t.title}`);
    }
    break;
  }
  case 'status': {
    const { byId } = tasks();
    const t = byId.get(rest[0]);
    if (!t) { console.error(`Unknown task "${rest[0]}".`); process.exit(1); }
    console.log(t.status);
    break;
  }
  case 'set-status': {
    const [id, status] = rest;
    if (!STATUSES.includes(status)) {
      console.error(`Unknown status "${status}". Use one of: ${STATUSES.join(', ')}`);
      process.exit(1);
    }
    const text = readPlan();
    const { byId } = tasks();
    const t = byId.get(id);
    if (!t) { console.error(`Unknown task "${id}".`); process.exit(1); }
    const lines = text.split('\n');
    // find an existing status line within the task block (above first ### )
    let statusLine = -1;
    for (let i = t.start; i < t.end; i++) {
      if (/^###\s/.test(lines[i])) break;
      if (/^\s*[-*]?\s*status:/i.test(lines[i])) { statusLine = i; break; }
    }
    if (statusLine !== -1) {
      lines[statusLine] = lines[statusLine].replace(/(status:\s*)\S+/i, `$1${status}`);
    } else {
      lines.splice(t.start + 1, 0, `- status: ${status}`); // insert right under the heading
    }
    writeFileSync(PLAN, lines.join('\n'));
    console.log(`${id} -> ${status}`);
    break;
  }
  default:
    console.log('Usage: board.mjs <next|wave|list|status <id>|set-status <id> <status>>');
    process.exit(cmd ? 1 : 0);
}

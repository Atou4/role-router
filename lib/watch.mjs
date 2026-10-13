// Role Router — the live picture behind `role-router watch`.
//
// snapshot() gathers it from files role-router already writes (no daemon): account pauses,
// launch records, and the "currently running" markers of every known repo. render() is pure.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { listActive } from './active.mjs';
import { accountStates } from './accounts.mjs';
import { loadConfig } from './config.mjs';
import { listLaunches } from './launch.mjs';
import { knownRepos } from './repos.mjs';
import { listEscalations } from './escalations.mjs';

/** One readable line for an agent event (Codex, Claude Code or OpenCode JSONL), or null. */
export function describeEvent(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }
  const clip = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 70);
  // Codex
  if (ev.type === 'item.completed' || ev.type === 'item.started') {
    const it = ev.item ?? {};
    if (it.type === 'agent_message' && it.text) return clip(it.text);
    if (it.type === 'command_execution' && it.command) return clip(`ran ${it.command}`);
    if (it.type === 'file_change') return 'edited files';
    if (it.type === 'error') return null;
  }
  // Claude Code
  if (ev.type === 'assistant') {
    for (const part of [...(ev.message?.content ?? [])].reverse()) {
      if (part.type === 'tool_use') return clip(`${part.name} ${part.input?.command ?? part.input?.file_path ?? part.input?.pattern ?? ''}`);
      if (part.type === 'text' && part.text) return clip(part.text);
    }
  }
  // OpenCode
  if (ev.type === 'text' && ev.part?.text) return clip(ev.part.text);
  if ((ev.type === 'tool_use' || ev.type === 'tool') && ev.part?.tool) return clip(`${ev.part.tool} ${ev.part.state?.input?.command ?? ev.part.state?.input?.filePath ?? ''}`);
  return null;
}

/** The most recent describable event in a JSONL log (reads only its tail). */
export function lastEvent(file, bytes = 16384) {
  if (!file || !existsSync(file)) return null;
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const d = describeEvent(lines[i]);
      if (d) return d;
    }
  } finally {
    closeSync(fd);
  }
  return null;
}

export function snapshot(now = new Date()) {
  let accounts = [];
  try { accounts = accountStates(loadConfig(), now); } catch { /* no config yet */ }
  const repos = knownRepos();
  const active = repos.flatMap((r) => listActive(r.root).map((a) => ({ ...a, repo: r.name, last: lastEvent(a.eventsPath) })));
  const launches = listLaunches().filter((l) => l.running || now - new Date(l.startedAt) < 6 * 3600_000);
  let inbox = [];
  try { inbox = listEscalations(repos.map((r) => r.root)); } catch { /* best effort */ }
  return { now, accounts, active, launches, inbox };
}

const ago = (from, now) => {
  const s = Math.max(0, Math.round((now - new Date(from)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

/** The screen, as text. */
export function render({ now, accounts, active, launches, inbox = [] }) {
  const out = [];
  out.push(`ACCOUNTS  ${accounts.map((a) => (a.pausedUntil ? `${a.account} paused until ${new Date(a.pausedUntil).toLocaleTimeString()} (${a.reason})` : `${a.account} ok`)).join(' · ') || '(no config)'}`);
  const rows = [];
  const seen = new Set();
  for (const a of active) {
    seen.add(`${a.repoRoot}|${a.task}`);
    rows.push([a.repo, a.task, a.stale ? 'stale' : a.operation, a.profile, ago(a.startedAt, now), a.stale ? 'process gone; role-router stop clears it' : (a.last ?? '…')]);
  }
  for (const l of launches) {
    for (const t of l.tasks) {
      if (seen.has(`${t.repoRoot}|${t.id}`)) continue;
      if (t.state === 'queued') rows.push([t.repo, t.id, 'queued', '—', '—', `launch ${l.id}`]);
      else if (t.state === 'running') rows.push([t.repo, t.id, 'between steps', '—', ago(t.startedAt, now), `launch ${l.id}`]);
      else if (t.state === 'waiting') rows.push([t.repo, t.id, 'waiting', '—', ago(t.startedAt, now), `all accounts limited; resumes ${new Date(t.waitingUntil).toLocaleTimeString()}`]);
      else rows.push([t.repo, t.id, t.state === 'stopped' ? 'stopped' : t.stop, '—', t.endedAt ? `${ago(t.endedAt, now)} ago` : '—', (t.message ?? '').replace(/\s+/g, ' ').slice(0, 70)]);
    }
  }
  if (rows.length === 0) {
    out.push('', 'Nothing running. Start with: role-router launch <tasks> --detach   (or role-router next / fanout)');
  } else {
    const head = ['REPO', 'TASK', 'STEP', 'AGENT', 'FOR', 'LAST'];
    const widths = head.map((h, i) => Math.min(i === 5 ? 70 : 24, Math.max(h.length, ...rows.map((r) => String(r[i]).length))));
    const fmt = (r) => r.map((c, i) => String(c).slice(0, widths[i]).padEnd(widths[i])).join('  ').trimEnd();
    out.push('', fmt(head), ...rows.map(fmt));
  }
  if (inbox.length) out.push('', `INBOX  ${inbox.length} waiting on you: ${inbox.slice(0, 3).map((e) => `${e.repo}:${e.task} [${e.type}]`).join(', ')}${inbox.length > 3 ? ', …' : ''}   → role-router inbox`);
  const running = launches.filter((l) => l.running);
  if (running.length) out.push('', `launches running: ${running.map((l) => `${l.id} (pid ${l.pid})`).join(', ')}   stop: role-router stop --all`);
  return out.join('\n');
}

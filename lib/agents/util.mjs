// Shared parsing helpers for agent modules (limit messages, reset times, process checks).

import { spawnSync } from 'node:child_process';

const UNIT_MS = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 };

/** "4 days 20 hours 9 minutes" → ms, or null when no unit is found. */
export function parseDuration(text) {
  let total = 0;
  let found = false;
  for (const [, n, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s*(week|day|hour|hr|minute|min|second|sec)s?\b/gi)) {
    const key = { hr: 'hour', min: 'minute', sec: 'second' }[unit.toLowerCase()] ?? unit.toLowerCase();
    total += Number(n) * UNIT_MS[key];
    found = true;
  }
  return found ? total : null;
}

/** "5pm", "5:30 pm", "17:00" → the next such wall-clock time after `now`. */
export function nextClockTime(text, now) {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || (!meridiem && !m[2])) return null;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * Best-effort reset time from an agent's limit message:
 *   "Try again in 4 days 20 hours"  |  "resets 5pm"  |  "try again at Oct 7, 2026 3:45 PM"
 * Returns a Date or null; callers fall back to the configured cooldown.
 */
export function parseResetFromText(text, now = new Date()) {
  if (!text) return null;
  const inMatch = text.match(/(?:try again|retry|resets?|available)\s+in\s+([^.\n]+)/i);
  if (inMatch) {
    const ms = parseDuration(inMatch[1]);
    if (ms) return new Date(now.getTime() + ms);
  }
  const atMatch = text.match(/(?:try again|resets?)\s+(?:at\s+)?([^.\n(]+)/i);
  if (atMatch) {
    const raw = atMatch[1].trim().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed) && /[a-z]{3}/i.test(raw) && parsed > now.getTime()) return new Date(parsed);
    const clock = nextClockTime(raw, now);
    if (clock) return clock;
  }
  return null;
}

export const LIMIT_RE = /usage limit|hit your (?:\w+ )?limit|limit reached|quota|out of credits|insufficient (?:credit|balance|quota)|plan limit|exceeded your/i;
export const TRANSIENT_RE = /rate.?limit|429|too many requests|overloaded|temporar|try again shortly/i;

/** Last `n` assistant texts joined, trimmed for handoff files. */
export function tailOf(messages, n = 3, max = 1500) {
  return messages.slice(-n).join('\n\n').slice(-max);
}

/** Run `executable --version`; returns a user-facing problem or null. */
export function checkInstalled(executable) {
  const r = spawnSync(executable, ['--version'], { stdio: 'ignore' });
  return r.error || r.status !== 0 ? `${executable} is not installed or not executable` : null;
}

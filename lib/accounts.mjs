// Role Router — user-wide usage-limit ledger (~/.role-router/state/accounts.json).
//
// Limits apply across every repo, so this lives beside the user config. Parallel
// fan-out lanes may write at once: each write re-reads the file, merges, and swaps
// it in atomically; a pause only ever extends (max of pausedUntil).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {object} AccountState
 * @property {string} account
 * @property {Date | null} pausedUntil   null = available
 * @property {string} [reason]
 * @property {string} [seenOn]           task id or "interactive"
 */

function ledgerPath() {
  const dir = process.env.ROLE_ROUTER_STATE_DIR || path.join(os.homedir(), '.role-router', 'state');
  return path.join(dir, 'accounts.json');
}

function read() {
  try { return JSON.parse(readFileSync(ledgerPath(), 'utf8')); } catch { return {}; }
}

function write(data) {
  const file = ledgerPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

/**
 * Current state for every account in the config; expired pauses read as available.
 * @param {import('./config.mjs').Config} config
 * @param {Date} [now]
 * @returns {AccountState[]}
 */
export function accountStates(config, now = new Date()) {
  const ledger = read();
  return Object.keys(config.accounts).map((account) => {
    const entry = ledger[account];
    const until = entry?.pausedUntil ? new Date(entry.pausedUntil) : null;
    const active = until && until > now;
    return { account, pausedUntil: active ? until : null, ...(active && { reason: entry.reason, seenOn: entry.seenOn }) };
  });
}

/**
 * Mark an account exhausted until `until`. Never shortens an existing pause.
 * @param {string} account
 * @param {Date} until
 * @param {{ reason: string, seenOn?: string }} detail
 */
export function pauseAccount(account, until, detail) {
  const ledger = read();
  const current = ledger[account]?.pausedUntil ? new Date(ledger[account].pausedUntil) : null;
  if (current && current > until) return;
  ledger[account] = { pausedUntil: until.toISOString(), reason: detail.reason, seenOn: detail.seenOn };
  write(ledger);
}

/** @param {string} account */
export function clearAccount(account) {
  const ledger = read();
  if (!(account in ledger)) return;
  delete ledger[account];
  write(ledger);
}

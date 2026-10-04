// Role Router — config loading (v2: accounts → profiles → role chains).
//
// v1 configs (`roles.<role> = { adapter, provider?, model?, keyEnv? }`) are upgraded
// in memory on load: each binding becomes one account, one profile and a one-entry chain.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {'codex' | 'claude' | 'opencode'} AgentName */
/** @typedef {'top' | 'lite'} Tier */

/**
 * A paid plan or API credential. Usage limits are tracked per account.
 * @typedef {object} Account
 * @property {AgentName} agent
 * @property {string} [provider]  OpenCode provider id (e.g. "zai-coding-plan")
 * @property {string} [keyEnv]    env var OpenCode reads; never read by Role Router itself
 */

/**
 * An account + model pairing that a Role can run on.
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} account     key into Config.accounts
 * @property {string} [model]     agent-native model id, passed through untouched (never validated here); omitted = agent default
 * @property {Tier} tier
 */

/**
 * @typedef {object} RolePolicy
 * @property {string[]} chain                 profile ids, most preferred first
 * @property {'ask' | 'auto'} onTierDrop      ask = consent before using a lower tier than chain[0]
 * @property {boolean} [avoidBuilderAccount]  worker only: prefer a different account than the task's Builder
 * @property {'ask' | 'auto'} [onSameAccountReview]  worker only: when only the Builder's account is usable (default 'ask')
 */

/**
 * @typedef {object} Config
 * @property {2} version
 * @property {Record<string, Account>} accounts
 * @property {Record<string, Profile>} profiles
 * @property {Record<'architect' | 'builder' | 'worker' | 'escalation', RolePolicy>} roles
 * @property {{ cooldownMinutes: number, transientRetries: number }} defaults
 */

const AGENTS = ['codex', 'claude', 'opencode'];
const TOP_ROLES = ['architect', 'escalation'];
const DEFAULTS = { cooldownMinutes: 60, transientRetries: 2 };

export function configPath() {
  return path.resolve(process.env.ROLE_ROUTER_CONFIG || path.join(os.homedir(), '.role-router', 'config.json'));
}

/**
 * Load, upgrade (v1 → v2), and validate the user config.
 * Throws an Error with a user-facing message on any problem.
 * @param {string} [file]
 * @returns {Config}
 */
export function loadConfig(file = configPath()) {
  if (!existsSync(file)) throw new Error(`missing ${file}; run \`role-router configure\``);
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`invalid JSON in ${file}: ${error.message}`); }
  return validate(raw.version === 2 ? raw : upgradeV1(raw), file);
}

function upgradeV1(raw) {
  const accounts = {};
  const profiles = {};
  const roles = {};
  for (const [role, b] of Object.entries(raw.roles ?? {})) {
    if (!b || b.adapter === 'unconfigured') continue;
    const account = b.adapter === 'opencode' ? `opencode-${b.provider ?? b.model?.split('/')[0] ?? 'default'}` : b.adapter;
    accounts[account] ??= { agent: b.adapter, ...(b.provider && { provider: b.provider }), ...(b.keyEnv && { keyEnv: b.keyEnv }) };
    profiles[role] = { account, ...(b.model && { model: b.model }), tier: TOP_ROLES.includes(role) ? 'top' : 'lite' };
    roles[role] = { chain: [role], onTierDrop: TOP_ROLES.includes(role) ? 'ask' : 'auto' };
  }
  return { version: 2, accounts, profiles, roles, defaults: raw.defaults };
}

function validate(c, file) {
  const bad = (msg) => { throw new Error(`${file}: ${msg}`); };
  const config = { version: 2, accounts: c.accounts ?? {}, profiles: {}, roles: c.roles ?? {}, defaults: { ...DEFAULTS, ...c.defaults } };
  for (const [id, a] of Object.entries(config.accounts)) {
    if (!AGENTS.includes(a.agent)) bad(`account "${id}" uses unknown agent "${a.agent}"`);
  }
  for (const [id, p] of Object.entries(c.profiles ?? {})) {
    if (!config.accounts[p.account]) bad(`profile "${id}" references unknown account "${p.account}"`);
    if (!['top', 'lite'].includes(p.tier)) bad(`profile "${id}" needs tier "top" or "lite"`);
    if (config.accounts[p.account].agent === 'opencode' && !p.model) bad(`profile "${id}" uses OpenCode but has no provider/model id`);
    config.profiles[id] = { id, ...p };
  }
  for (const [role, policy] of Object.entries(config.roles)) {
    if (!Array.isArray(policy.chain) || policy.chain.length === 0) bad(`role "${role}" has an empty chain`);
    for (const id of policy.chain) if (!config.profiles[id]) bad(`role "${role}" lists unknown profile "${id}"`);
  }
  return config;
}

// Role Router — build a v2 config from the accounts a user chooses (used by `role-router configure`).
//
// Kept pure so the proposal is testable: detection and prompting live in scripts/configure.mjs.

import { spawnSync } from 'node:child_process';

/**
 * @typedef {object} AccountChoice
 * @property {string} id                 account key, e.g. "openai", "anthropic", "zai"
 * @property {'codex' | 'claude' | 'opencode'} agent
 * @property {string} [provider]         OpenCode provider id
 * @property {string} [keyEnv]           env var holding the provider key (OpenCode only)
 * @property {string} [topModel]         planning-grade model id ('' = agent default)
 * @property {string} [liteModel]        execution-grade model id ('' = agent default)
 */

/**
 * Profiles: `<id>-top` and/or `<id>-lite` per account. Chains: planning walks every top profile
 * then the lite ones (tier drop asks first); execution walks lite profiles in `executionOrder`,
 * then top ones as a last resort; review uses the same order but avoids the Builder's account.
 * @param {AccountChoice[]} accounts
 * @param {{ executionOrder?: string[], cooldownMinutes?: number }} [opts]
 * @returns {import('./config.mjs').Config}
 */
export function proposeConfig(accounts, opts = {}) {
  if (accounts.length === 0) throw new Error('choose at least one account');
  const config = { version: 2, accounts: {}, profiles: {}, roles: {}, defaults: { cooldownMinutes: opts.cooldownMinutes ?? 60, transientRetries: 2, runTimeoutMinutes: 30 } };
  const top = [];
  const lite = [];
  for (const a of accounts) {
    config.accounts[a.id] = { agent: a.agent, ...(a.provider && { provider: a.provider }), ...(a.keyEnv && { keyEnv: a.keyEnv }) };
    const add = (tier, model) => {
      const id = `${a.id}-${tier}`;
      if (a.agent === 'opencode' && !model) throw new Error(`${a.id}: OpenCode needs a provider/model id for its ${tier} profile`);
      config.profiles[id] = { account: a.id, ...(model && { model }), tier };
      (tier === 'top' ? top : lite).push({ id, account: a.id });
    };
    if (a.topModel !== undefined) add('top', a.topModel);
    if (a.liteModel !== undefined) add('lite', a.liteModel);
  }
  const order = opts.executionOrder ?? accounts.map((a) => a.id);
  const byOrder = (list) => [...list].sort((x, y) => order.indexOf(x.account) - order.indexOf(y.account)).map((p) => p.id);
  const ids = (list) => list.map((p) => p.id);
  const planning = top.length ? [...ids(top), ...byOrder(lite)] : byOrder(lite);
  const execution = [...byOrder(lite), ...byOrder(top)];
  config.roles = {
    architect: { chain: planning, onTierDrop: 'ask' },
    builder: { chain: execution, onTierDrop: 'auto' },
    worker: { chain: execution, onTierDrop: 'auto', avoidBuilderAccount: true, onSameAccountReview: 'ask' },
    escalation: { chain: top.length ? ids(top) : byOrder(lite), onTierDrop: 'ask' },
  };
  return config;
}

/** What is installed and signed in, without reading any credential. */
export function detectAgents(run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000 })) {
  const ok = (r) => !r.error && r.status === 0;
  const codex = run('codex', ['--version']);
  const claude = run('claude', ['--version']);
  const opencode = run('opencode', ['--version']);
  const claudeAuth = ok(claude) ? run('claude', ['auth', 'status']) : null;
  let opencodeProviders = [];
  if (ok(opencode)) {
    const models = run('opencode', ['models']);
    if (ok(models)) opencodeProviders = [...new Set(models.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)).map((l) => l.split('/')[0]))];
  }
  return {
    codex: { installed: ok(codex), signedIn: ok(codex) && ok(run('codex', ['login', 'status'])) },
    claude: { installed: ok(claude), signedIn: Boolean(claudeAuth && ok(claudeAuth) && /"loggedIn":\s*true/.test(claudeAuth.stdout)) },
    opencode: { installed: ok(opencode), providers: opencodeProviders },
  };
}

/** Model ids OpenCode can reach for one provider (empty when unknown). */
export function opencodeModels(provider, run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000 })) {
  const r = run('opencode', ['models', provider]);
  return !r.error && r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${provider}/`)) : [];
}

#!/usr/bin/env node

// role-router configure — choose your paid accounts and models, write ~/.role-router/config.json (v2).
//
//   role-router configure            interactive
//   role-router configure --print    show what detection + defaults would write, change nothing
//
// The wizard detects which agents are installed and signed in; it never reads or stores a
// subscription token. OpenCode API keys stay in your shell environment (keyEnv names the variable).

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { configPath, loadConfig } from '../lib/config.mjs';
import { detectAgents, opencodeModels, proposeConfig } from '../lib/setup.mjs';

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const PRINT = process.argv.includes('--print');
const SUGGEST = {
  codex: { top: 'gpt-6-sol', lite: 'gpt-6-luna' },
  claude: { top: 'opus', lite: 'sonnet' },
};

const detected = detectAgents();
const file = configPath();

console.log(bold('Role Router setup'));
console.log(dim('Model ids are passed to each agent untouched; use the exact ids your plan offers. Blank = the agent\'s own default.\n'));
const mark = (b) => (b ? '✓' : '✗');
console.log(`  Codex CLI     installed ${mark(detected.codex.installed)}  signed in ${mark(detected.codex.signedIn)}`);
console.log(`  Claude Code   installed ${mark(detected.claude.installed)}  signed in ${mark(detected.claude.signedIn)}`);
console.log(`  OpenCode      installed ${mark(detected.opencode.installed)}  providers: ${detected.opencode.providers.join(', ') || 'none found'}\n`);

const rl = PRINT ? null : createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = '') => {
  if (PRINT) return def;
  const a = (await rl.question(`${q}${def ? dim(` [${def}]`) : ''} `)).trim();
  return a === '-' ? '' : a || def;
};
const yes = async (q, def) => /^y/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));

const accounts = [];
try {
  if (detected.codex.installed && await yes('Use your ChatGPT plan through Codex?', detected.codex.signedIn)) {
    accounts.push({ id: 'openai', agent: 'codex',
      topModel: await ask('  Codex planning model', SUGGEST.codex.top),
      liteModel: await ask('  Codex execution model', SUGGEST.codex.lite) });
  }
  if (detected.claude.installed && await yes('Use your Claude plan through Claude Code?', detected.claude.signedIn)) {
    accounts.push({ id: 'anthropic', agent: 'claude',
      topModel: await ask('  Claude planning model', SUGGEST.claude.top),
      liteModel: await ask('  Claude execution model', SUGGEST.claude.lite) });
  }
  if (detected.opencode.installed) {
    const providers = PRINT ? detected.opencode.providers.slice(0, 1) : [];
    while (!PRINT && await yes(`Add an OpenCode provider${accounts.some((a) => a.agent === 'opencode') ? ' (another)' : ''}?`, accounts.every((a) => a.agent !== 'opencode') && detected.opencode.providers.length > 0)) {
      providers.push(await ask('  provider id', detected.opencode.providers[0] ?? ''));
    }
    for (const provider of providers.filter(Boolean)) {
      const models = opencodeModels(provider);
      if (models.length && !PRINT) console.log(dim(`  models: ${models.slice(0, 12).join(', ')}${models.length > 12 ? ', …' : ''}`));
      const lite = await ask(`  ${provider} execution model (provider/model)`, models[0] ?? '');
      const topModel = await ask(`  ${provider} planning model (blank = none)`, '');
      const keyEnv = await ask('  env var with its API key (blank = OpenCode stored login)', '');
      accounts.push({ id: provider, agent: 'opencode', provider, ...(keyEnv && { keyEnv }), liteModel: lite, ...(topModel && { topModel }) });
    }
  }
  if (accounts.length === 0) throw new Error('no accounts chosen');

  const ids = accounts.map((a) => a.id);
  const order = (await ask(`Execution order, most preferred first (${ids.join(', ')})`, ids.join(','))).split(',').map((s) => s.trim()).filter((s) => ids.includes(s));
  const config = proposeConfig(accounts, { executionOrder: [...order, ...ids.filter((i) => !order.includes(i))] });

  console.log(bold('\nChains'));
  for (const [role, policy] of Object.entries(config.roles)) console.log(`  ${role.padEnd(10)} ${policy.chain.join(' → ')}${policy.onTierDrop === 'ask' ? dim('  (asks before a lighter tier)') : ''}`);
  for (const a of accounts) if (a.keyEnv && !process.env[a.keyEnv]) console.log(`  note: ${a.keyEnv} is not set in this shell; export it in your profile.`);

  if (PRINT) { console.log(`\n${JSON.stringify(config, null, 2)}`); process.exit(0); }
  if (!(await yes(`\nWrite ${file}?`, true))) { console.log('Nothing written.'); process.exit(0); }
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
    console.log(dim(`previous config saved to ${backup}`));
  }
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  loadConfig(file);
  console.log(`Wrote ${file}. Try: role-router run architect "<feature>" --dry-run`);
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exitCode = 1;
} finally {
  rl?.close();
}

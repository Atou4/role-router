#!/usr/bin/env node

// role-router limits — show or edit the usage-limit ledger.
//
//   role-router limits                                  show every account
//   role-router limits pause <account> [--until=WHEN]   after hitting a limit in an interactive session
//   role-router limits clear <account>
//
// WHEN: +90m | +2h | 17:30 | an ISO date. Default: the config's cooldownMinutes from now.

import { accountStates, clearAccount, pauseAccount } from '../lib/accounts.mjs';
import { loadConfig } from '../lib/config.mjs';
import { nextClockTime, parseDuration } from '../lib/agents/util.mjs';

const [cmd, account, ...rest] = process.argv.slice(2);
const untilArg = rest.find((a) => a.startsWith('--until='))?.slice(8);

try {
  const config = loadConfig();
  const known = (name) => {
    if (!config.accounts[name]) throw new Error(`unknown account "${name}"; known: ${Object.keys(config.accounts).join(', ')}`);
  };

  if (!cmd) {
    for (const s of accountStates(config)) {
      const state = s.pausedUntil ? `paused until ${s.pausedUntil.toLocaleString()}  (${s.reason}${s.seenOn ? `, seen on ${s.seenOn}` : ''})` : 'ok';
      console.log(`${s.account.padEnd(24)} ${config.accounts[s.account].agent.padEnd(9)} ${state}`);
    }
  } else if (cmd === 'pause') {
    known(account);
    const now = new Date();
    const until = !untilArg ? new Date(now.getTime() + config.defaults.cooldownMinutes * 60_000)
      : untilArg.startsWith('+') ? new Date(now.getTime() + (parseDuration(untilArg.slice(1).replace(/^(\d+)([mhd])$/, (_, n, u) => `${n} ${{ m: 'minute', h: 'hour', d: 'day' }[u]}`)) ?? NaN))
      : /^\d{1,2}:\d{2}$/.test(untilArg) ? nextClockTime(untilArg, now)
      : new Date(untilArg);
    if (!until || Number.isNaN(until.getTime())) throw new Error(`cannot read --until=${untilArg}; use +90m, +2h, 17:30, or an ISO date`);
    pauseAccount(account, until, { reason: 'manual', seenOn: 'interactive' });
    console.log(`${account} paused until ${until.toLocaleString()}`);
  } else if (cmd === 'clear') {
    known(account);
    clearAccount(account);
    console.log(`${account} cleared`);
  } else {
    throw new Error('usage: role-router limits [pause <account> [--until=WHEN] | clear <account>]');
  }
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}

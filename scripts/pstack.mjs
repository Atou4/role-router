#!/usr/bin/env node

// role-router pstack — write ~/.cursor/rules/pstack-models.mdc so pstack skills run their
// runners, reviewers and judges on your Role Router profiles through `role-router fan`.
//
//   role-router pstack            write the rule (an existing one is backed up first)
//   role-router pstack --print    show it, change nothing

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { PSTACK_RULE, pstackModelsRule } from '../lib/pstack.mjs';

try {
  const rule = pstackModelsRule(loadConfig());
  if (process.argv.includes('--print')) { process.stdout.write(rule); process.exit(0); }
  mkdirSync(path.dirname(PSTACK_RULE), { recursive: true });
  if (existsSync(PSTACK_RULE) && readFileSync(PSTACK_RULE, 'utf8') !== rule) {
    const backup = `${PSTACK_RULE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(PSTACK_RULE, backup);
    console.log(`previous rule saved to ${backup}`);
  }
  writeFileSync(PSTACK_RULE, rule);
  console.log(`wrote ${PSTACK_RULE}; pstack skills now run their model panels through role-router fan (new sessions).`);
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}

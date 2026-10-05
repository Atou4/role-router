#!/usr/bin/env node

// role-router fan — one prompt, several models, one answer file per model.
//
//   role-router fan "<prompt>"                       default: one top profile per account
//   role-router fan --profiles=openai-top,anthropic-top --prompt-file=task.md
//   role-router fan --worktree ...                   each lane gets its own detached worktree
//   role-router fan --timeout=5 ...                  minutes per lane before it is stopped (default 10)
//   role-router fan --list                           show the default lanes
//
// Answers land in .role-router/fan/<stamp>/<profile>.md with fan.json as the index.
// Use it wherever a skill asks for runners or reviewers on different models
// (architect, arena, interrogate, how): pass the filled prompt, then read every answer.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { defaultFanProfiles, fan } from '../lib/fan.mjs';

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name) => args.includes(`--${name}`);

try {
  const config = loadConfig();
  const profiles = opt('profiles')?.split(',').map((s) => s.trim()).filter(Boolean) ?? defaultFanProfiles(config);
  for (const p of profiles) if (!config.profiles[p]) throw new Error(`unknown profile "${p}"; known: ${Object.keys(config.profiles).join(', ')}`);
  if (has('list')) {
    for (const p of profiles) console.log(`${p.padEnd(16)} ${config.profiles[p].account.padEnd(14)} ${config.profiles[p].model ?? '(agent default)'}`);
    process.exit(0);
  }
  const file = opt('prompt-file');
  const prompt = file ? readFileSync(file, 'utf8') : args.filter((a) => !a.startsWith('--')).join(' ');
  const { out, lanes } = await fan({
    prompt, profiles, worktree: has('worktree'), timeoutMinutes: Number(opt('timeout') ?? 10),
    cwd: path.resolve(opt('cwd') || process.cwd()), out: opt('out') && path.resolve(opt('out')),
  });
  for (const l of lanes) console.log(`${l.status === 'ok' ? '✓' : '✗'} ${l.profile.padEnd(16)} ${l.answer ?? `${l.status}: ${l.message ?? ''}`}`);
  console.log(`index: ${path.join(out, 'fan.json')}`);
  process.exit(lanes.some((l) => l.status === 'ok') ? 0 : 1);
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}

#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const option = (name) => {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit?.slice(prefix.length);
};
const positional = argv.filter((arg) => !['--headless', '--dry-run', '--raw'].includes(arg) && !arg.startsWith('--cwd='));
const requestedRole = positional.shift();
const roleArgument = positional.join(' ');
const headless = has('--headless');
const dryRun = has('--dry-run');
const raw = has('--raw');
const cwd = path.resolve(option('cwd') || process.cwd());
const configPath = path.resolve(
  process.env.ROLE_ROUTER_CONFIG || path.join(os.homedir(), '.role-router', 'config.json'),
);

const roleCommands = {
  architect: 'plan',
  builder: 'build',
  worker: 'review',
  review: 'review',
  docs: 'docs',
  escalation: 'build',
};

function fail(message) {
  console.error(`role-router: ${message}`);
  process.exit(1);
}

if (!requestedRole || !roleCommands[requestedRole]) {
  fail('usage: role-router run <architect|builder|worker|review|docs|escalation> [argument] [--raw] [--headless] [--cwd=DIR]');
}
if (!existsSync(configPath)) {
  fail(`missing ${configPath}; run the Role Router installer/configurator first`);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  fail(`invalid JSON in ${configPath}: ${error.message}`);
}
const bindingRole = ['review', 'docs'].includes(requestedRole) ? 'worker' : requestedRole;
const binding = config.roles?.[bindingRole];
if (!binding || binding.adapter === 'unconfigured') {
  fail(`role ${bindingRole} has no configured engine in ${configPath}`);
}
if (!['codex', 'claude', 'opencode'].includes(binding.adapter)) {
  fail(`role ${bindingRole} uses unknown adapter "${binding.adapter}"`);
}
if (binding.adapter === 'opencode' && !binding.model) {
  fail(`role ${bindingRole} uses OpenCode but has no provider/model ID`);
}

const commandName = roleCommands[requestedRole];
const commandPath = raw ? null : resolveCommand(commandName);
if (raw && !roleArgument) fail('--raw requires an initial message');
let prompt = raw
  ? roleArgument
  : stripFrontmatter(readFileSync(commandPath, 'utf8')).replaceAll('$ARGUMENTS', roleArgument);
if (requestedRole === 'escalation') {
  prompt = `You are handling an escalated Builder task after two failed focused attempts. Diagnose the recorded blocker, complete the task, and preserve the task status contract.\n\n${prompt}`;
}

const launch = buildLaunch(binding, prompt);
if (dryRun) {
  console.log(JSON.stringify({
    role: requestedRole,
    bindingRole,
    adapter: binding.adapter,
    command: launch.command,
    args: launch.args.map((arg) => arg === prompt ? '<role-prompt>' : arg),
    cwd,
    commandPath,
  }, null, 2));
  process.exit(0);
}

await preflight(binding.adapter);
const child = spawn(launch.command, launch.args, {
  cwd,
  env: launch.env,
  stdio: 'inherit',
});
child.on('error', (error) => fail(`could not launch ${launch.command}: ${error.message}`));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

function resolveCommand(name) {
  const roots = [
    path.resolve(SCRIPT_DIR, '..', 'commands'),
    path.join(SCRIPT_DIR, 'commands'),
    path.join(os.homedir(), '.claude', 'commands'),
  ];
  const hit = roots.map((root) => path.join(root, `${name}.md`)).find(existsSync);
  if (!hit) fail(`could not find commands/${name}.md`);
  return hit;
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

function buildLaunch(engine, rolePrompt) {
  if (engine.adapter === 'codex') {
    const args = headless ? ['exec', '-C', cwd] : ['-C', cwd];
    if (engine.model) args.push('--model', engine.model);
    args.push('--sandbox', 'workspace-write');
    if (headless) args.push('--json');
    args.push(rolePrompt);
    return { command: 'codex', args, env: process.env };
  }

  if (engine.adapter === 'opencode') {
    const args = headless
      ? ['run', '--dir', cwd, '--model', engine.model, '--format', 'json', rolePrompt]
      : [cwd, '--model', engine.model, '--prompt', rolePrompt];
    return { command: 'opencode', args, env: process.env };
  }

  const args = headless
    ? ['-p', rolePrompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--add-dir', cwd]
    : [rolePrompt];
  return { command: 'claude', args, env: process.env };
}

async function preflight(adapter) {
  const executable = adapter === 'codex' ? 'codex' : adapter === 'opencode' ? 'opencode' : 'claude';
  const installed = spawnSync(executable, ['--version'], { stdio: 'ignore' });
  if (installed.error || installed.status !== 0) fail(`${executable} is not installed or not executable`);
  if (adapter === 'codex') {
    const auth = spawnSync('codex', ['login', 'status'], { encoding: 'utf8' });
    if (auth.status !== 0) fail('Codex CLI is not signed in; run `codex login` first');
  }
  if (adapter === 'opencode' && binding.keyEnv && !process.env[binding.keyEnv]) {
    const auth = spawnSync('opencode', ['auth', 'list'], { encoding: 'utf8' });
    if (auth.status !== 0 || !auth.stdout.includes(binding.provider || binding.model.split('/')[0])) {
      fail(`${binding.keyEnv} is not set and OpenCode has no matching stored login; run \`opencode auth login\``);
    }
  }
}

#!/usr/bin/env node

/**
 * Role Router interactive configuration CLI
 * Prompts user for their providers, API keys, proposes routing, lets them customize.
 * Outputs: ~/.role-router/config.json + shell instructions
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = [
  process.env.ROLE_ROUTER_PROVIDER_CATALOG,
  path.join(__dirname, '../providers/catalog.json'),
  path.join(__dirname, 'providers/catalog.json'),
].filter(Boolean).find(fs.existsSync);
const ROLE_OUTPUT_PATH = path.join(os.homedir(), '.role-router', 'config.json');

// ANSI codes for terminal colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function bold(str) { return `${colors.bold}${str}${colors.reset}`; }
function dim(str) { return `${colors.dim}${str}${colors.reset}`; }
function green(str) { return `${colors.green}${str}${colors.reset}`; }
function yellow(str) { return `${colors.yellow}${str}${colors.reset}`; }
function cyan(str) { return `${colors.cyan}${str}${colors.reset}`; }

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Load catalog
let catalog;
try {
  catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
} catch (e) {
  console.error(yellow('⚠ Provider catalog not found. Run from the role-router directory.'));
  process.exit(1);
}

console.clear();
console.log(cyan(bold('┌─ Role Router Setup ───────────────────────────────┐')));
console.log(cyan('│                                                      │'));
console.log(cyan('│  Let\'s wire up the providers you have.                │'));
console.log(cyan('│                                                      │'));
console.log(cyan('└──────────────────────────────────────────────────────┘'));
console.log();

// Step 0: subscription-backed harnesses
console.log(bold('Do you have a ChatGPT Plus/Pro plan with Codex access?'));
console.log(dim('(Codex is launched through the signed-in Codex CLI; no OpenAI API key is used)'));
console.log();

const hasCodexAnswer = await question('  Use Codex CLI subscription? (y/N): '.trim() + ' ');
const hasCodex = hasCodexAnswer.toLowerCase().startsWith('y');
if (hasCodex) {
  console.log(dim('✓ Architect will use the signed-in Codex CLI'));
  console.log(dim('  Run `codex login status` if you have not signed in yet.'));
}
console.log();

// Step 0b: Claude Max subscription?
console.log(bold('Do you have a Claude Code Max subscription?'));
console.log(dim('(Used for Architect only when Codex subscription routing is not selected)'));
console.log();

const hasMaxAnswer = await question('  Have Claude Code Max? (Y/n): '.trim() + ' ');
const hasMax = !hasMaxAnswer.toLowerCase().startsWith('n');

console.log();
if (hasCodex) {
  console.log(dim('✓ Architect will use Codex CLI subscription auth'));
} else if (hasMax) {
  console.log(dim('✓ Architect will run on Max (vanilla context)'));
} else {
  console.log(dim('⚠ Architect will use your strongest configured OpenCode model'));
}
console.log();

// Step 1: Select providers
console.log(bold('Which plans/providers do you currently have?'));
if (hasMax) {
  console.log(dim('☑ Claude Code Max    (Architect stays on vanilla)'));
} else {
  console.log(dim('☐ Claude Code Max    (not available — Architect uses OpenCode)'));
}
console.log();

const providerOptions = [
  { key: 'zai-coding', name: 'Z.AI GLM Coding Plan' },
  { key: 'zai', name: 'Z.AI General API (pay as you go)' },
  { key: 'openai', name: 'OpenAI API key (separate from ChatGPT/Codex)' },
  { key: 'openrouter', name: 'OpenRouter API' },
  { key: 'anthropic', name: 'Anthropic API key (paid, for escalation only)' }
];

const selectedProviders = [];

for (const provider of providerOptions) {
  const answer = await question(`  Add ${provider.name}? (y/N): `.trim() + ' ');
  if (answer.toLowerCase() === 'y') {
    selectedProviders.push(provider.key);
  }
}

if (selectedProviders.includes('zai-coding') && selectedProviders.includes('zai')) {
  console.log(yellow('\n⚠ Both Z.AI modes selected; keeping Coding Plan because one key must use one endpoint.'));
  selectedProviders.splice(selectedProviders.indexOf('zai'), 1);
}

if (selectedProviders.length === 0) {
  console.log(yellow('\n⚠ No providers selected. At minimum, you need one for Builder and Worker.'));
  console.log(dim('  If you only have Claude Max, you can still use /plan but the build steps need a provider.'));
  const continueAnyway = await question('\nContinue anyway? (y/N): ');
  if (continueAnyway.toLowerCase() !== 'y') {
    console.log(dim('\nSetup cancelled. Add a provider key when you have one.'));
    process.exit(0);
  }
}

// Step 2: Check provider authentication
console.log();
console.log(bold('┌─ Provider authentication ───────────────────────┐'));
console.log();

for (const key of selectedProviders) {
  const provider = catalog.providers[key];
  const envName = provider.api_key_env;
  const state = process.env[envName] ? green('available in environment') : yellow('not set');
  console.log(`  ${provider.name}: ${envName} ${state}`);
}
if (selectedProviders.some((key) => !process.env[catalog.providers[key].api_key_env])) {
  console.log();
  console.log(dim('Missing keys can be configured securely with `opencode auth login`'));
  console.log(dim('or exported in your shell profile before launching a role.'));
}

// Step 3: Propose routing
console.log();
console.log(bold('┌─ Proposed configuration ───────────────────────────┐'));
console.log();

const proposedRouting = proposeRouting(selectedProviders, catalog, hasMax, hasCodex);

console.log(dim('Based on what you have, here\'s a sane setup:'));
console.log();
for (const [role, entry] of Object.entries(proposedRouting)) {
  console.log(`  ${role.padEnd(12)} -> ${(entry.model || '(none)').padEnd(20)} ${entry.provider || ''}`);
}
console.log();

// Show costs summary
console.log(dim('Your costs:'));
console.log(dim(`  • Architect uses ${proposedRouting.Architect.provider || 'no configured engine'}`));
if (proposedRouting.Builder.model) {
  console.log(dim(`  • Builder hits ${proposedRouting.Builder.provider}`));
}
if (proposedRouting.Worker.model) {
  console.log(dim(`  • Worker hits ${proposedRouting.Worker.provider}`));
}
if (proposedRouting.Escalation.model) {
  console.log(dim(`  • Escalation uses ${proposedRouting.Escalation.provider}`));
}
console.log();

const customize = await question(bold('[A]ccept  [C]ustomize models: ').toLowerCase());

let finalRouting = proposedRouting;

if (customize === 'c') {
  finalRouting = await customizeRouting(proposedRouting, selectedProviders, catalog);
}

// Step 4: Generate role config
console.log();
console.log(bold('┌─ Generating configuration ────────────────────────┐'));
console.log();

const roleConfig = generateRoleConfig(finalRouting, selectedProviders, catalog, { hasCodex, hasMax });

fs.mkdirSync(path.dirname(ROLE_OUTPUT_PATH), { recursive: true });
fs.writeFileSync(ROLE_OUTPUT_PATH, JSON.stringify(roleConfig, null, 2));
console.log(green('✓ Role bindings written to ~/.role-router/config.json'));
console.log();

// Show shell instructions
console.log(bold('┌─ Shell exports ──────────────────────────────────┐'));
console.log();

const missingEnvs = [...new Set(selectedProviders
  .map((key) => catalog.providers[key].api_key_env)
  .filter((envName) => !process.env[envName]))];
if (missingEnvs.length > 0) {
  console.log(dim('Authenticate with `opencode auth login`, or export:'));
  for (const envName of missingEnvs) console.log(`  export ${envName}="..."`);
} else {
  console.log(dim('All selected provider keys are available in the environment.'));
}
console.log();

console.log(bold('┌─ Next steps ────────────────────────────────────┐'));
console.log();
console.log(dim('  Start using Role Router:'));
console.log(dim('    role-router run architect "<feature>"'));
console.log(dim('    role-router run builder TASK-001'));
console.log();
console.log(dim('  See README.md for the full guide.'));
console.log();
console.log(cyan(bold('                    Setup complete!')));
console.log();

rl.close();

function proposeRouting(providers, catalog, hasMax = true, hasCodex = false) {
  const routing = {
    Architect: { model: null, provider: null },
    Builder: { model: null, provider: null },
    Worker: { model: null, provider: null },
    Escalation: { model: null, provider: null }
  };

  // Architect routing
  if (hasCodex) {
    routing.Architect = { model: 'Codex subscription', provider: 'Codex CLI' };
  } else if (hasMax) {
    routing.Architect = { model: 'Claude Opus (Max)', provider: 'Max (vanilla)' };
  } else {
    // No Max: route Architect through strongest available model
    if (providers.includes('openai')) {
      const o1 = catalog.providers.openai.models.find(m => m.id === 'o1');
      if (o1) {
        routing.Architect = { model: 'o1', provider: catalog.providers.openai.name };
      } else {
        // Fall back to o3-mini if o1 not available
        routing.Architect = { model: 'o3-mini', provider: catalog.providers.openai.name };
      }
    }
    else if (providers.includes('openrouter')) {
      const claude = catalog.providers.openrouter.models.find(m => m.id === 'anthropic/claude-opus-4.8');
      if (claude) {
        routing.Architect = { model: claude.id, provider: catalog.providers.openrouter.name };
      } else {
        // Fall back to GLM-5.2
        const glm = catalog.providers.openrouter.models.find(m => m.id === 'z-ai/glm-5.2');
        if (glm) {
          routing.Architect = { model: glm.id, provider: catalog.providers.openrouter.name };
        }
      }
    }
    else if (providers.includes('zai-coding') || providers.includes('zai')) {
      const key = providers.includes('zai-coding') ? 'zai-coding' : 'zai';
      routing.Architect = { model: 'glm-5.2', provider: catalog.providers[key].name };
    }
    // If still no Architect model, set to first available model
    if (!routing.Architect.model && providers.length > 0) {
      const firstProvider = catalog.providers[providers[0]];
      if (firstProvider && firstProvider.models.length > 0) {
        routing.Architect = {
          model: firstProvider.models[0].id,
          provider: firstProvider.name
        };
      }
    }
  }

  // Prefer OpenAI o3-mini for Builder if available
  if (providers.includes('openai')) {
    const o3mini = catalog.providers.openai.models.find(m => m.id === 'o3-mini');
    if (o3mini) {
      routing.Builder = { model: 'o3-mini', provider: 'OpenAI' };
    }
  }
  // Prefer the efficient daily-development model for Z.AI.
  else if (providers.includes('zai-coding') || providers.includes('zai')) {
    const key = providers.includes('zai-coding') ? 'zai-coding' : 'zai';
    const glm = catalog.providers[key].models.find(m => m.id === 'glm-4.7')
      || catalog.providers[key].models.find(m => m.id === 'glm-5.2');
    if (glm) {
      routing.Builder = { model: glm.id, provider: catalog.providers[key].name };
    }
  }
  // Fall back to OpenRouter Kimi
  else if (providers.includes('openrouter')) {
    const kimi = catalog.providers.openrouter.models.find(m => m.id === 'moonshotai/kimi-k2.7-code')
      || catalog.providers.openrouter.models.find(m => m.id === 'moonshotai/kimi-k2.6');
    if (kimi) {
      routing.Builder = { model: kimi.id, provider: catalog.providers.openrouter.name };
    }
  }

  // Prefer cheapest option for Worker
  if (providers.includes('openrouter')) {
    const flash = catalog.providers.openrouter.models.find(m => m.id === 'deepseek/deepseek-v4-flash');
    if (flash) {
      routing.Worker = { model: flash.id, provider: catalog.providers.openrouter.name };
    }
  }
  else if (providers.includes('zai-coding') || providers.includes('zai')) {
    const key = providers.includes('zai-coding') ? 'zai-coding' : 'zai';
    const glmFlash = catalog.providers[key].models.find(m => m.id === 'glm-4.7');
    if (glmFlash) {
      routing.Worker = { model: glmFlash.id, provider: catalog.providers[key].name };
    }
  }

  // Escalation defaults to the strongest available model
  if (providers.includes('zai-coding') || providers.includes('zai')) {
    const key = providers.includes('zai-coding') ? 'zai-coding' : 'zai';
    routing.Escalation = { model: 'glm-5.2', provider: catalog.providers[key].name };
  }
  else if (hasCodex) {
    routing.Escalation = { model: 'Codex subscription', provider: 'Codex CLI' };
  }
  else if (providers.includes('anthropic')) {
    routing.Escalation = { model: 'claude-opus-4.8', provider: 'Anthropic (paid)' };
  }
  else if (providers.includes('openrouter') && routing.Builder.provider === 'OpenRouter') {
    // If on OpenRouter, use Claude Opus for escalation
    routing.Escalation = { model: 'claude-opus-4.8', provider: 'OpenRouter' };
  }

  return routing;
}

async function customizeRouting(proposed, providers, catalog) {
  const roles = ['Builder', 'Worker', 'Escalation'];
  const routing = { ...proposed };

  for (const role of roles) {
    console.log();
    console.log(bold(`┌─ Customize ${role} model ─────────────────────────┐`));
    console.log();

    // Show available models from selected providers
    const availableModels = [];
    for (const key of providers) {
      const provider = catalog.providers[key];
      for (const model of provider.models) {
        const hint = catalog.role_hints[model.role_hint] || '';
        availableModels.push({
          provider: provider.name,
          modelId: model.id,
          modelName: model.name,
          hint
        });
      }
    }

    // Group by provider
    const byProvider = {};
    for (const m of availableModels) {
      if (!byProvider[m.provider]) byProvider[m.provider] = [];
      byProvider[m.provider].push(m);
    }

    console.log(dim(`Available models (${availableModels.length} total):`));
    console.log();
    let idx = 1;
    const modelMap = [{ provider: '(skip)', modelId: null, modelName: '(none)' }];
    for (const [prov, models] of Object.entries(byProvider)) {
      console.log(cyan(`${prov}:`));
      for (const m of models) {
        console.log(`  ${idx}. ${m.modelName} ${dim(m.hint)}`);
        modelMap.push({ provider: prov, modelId: m.modelId, modelName: m.modelName });
        idx++;
      }
    }
    console.log();

    const current = routing[role].model || 'none';
    const answer = await question(`${role} model [${current}] (1-${modelMap.length - 1}, or enter to keep): `);

    if (answer && answer !== '') {
      const num = parseInt(answer, 10);
      if (num >= 1 && num < modelMap.length) {
        const selected = modelMap[num];
        routing[role] = {
          model: selected.modelId,
          provider: selected.provider
        };
      }
    }
  }

  return routing;
}

function generateRoleConfig(routing, providers, catalog, subscriptions) {
  const opencodeBinding = (entry) => {
    if (!entry?.model) return { adapter: 'unconfigured' };
    const match = findProviderForModel(entry.model, providers, catalog, entry.provider);
    if (!match) return { adapter: 'unconfigured' };
    const providerIds = {
      'zai-coding': 'zai-coding-plan',
      zai: 'zai',
      openrouter: 'openrouter',
      openai: 'openai',
      anthropic: 'anthropic'
    };
    const provider = providerIds[match.provider] || match.provider;
    return {
      adapter: 'opencode',
      provider,
      model: `${provider}/${match.modelId}`,
      keyEnv: catalog.providers[match.provider].api_key_env
    };
  };

  const architect = subscriptions.hasCodex
    ? { adapter: 'codex', mode: 'interactive' }
    : subscriptions.hasMax
      ? { adapter: 'claude', mode: 'interactive' }
      : opencodeBinding(routing.Architect);

  const escalation = opencodeBinding(routing.Escalation);

  return {
    version: 1,
    _comment: 'Role bindings. Codex uses subscription auth; OpenCode uses provider API keys or its auth store.',
    roles: {
      architect,
      builder: opencodeBinding(routing.Builder),
      worker: opencodeBinding(routing.Worker),
      escalation
    }
  };
}

function findProviderForModel(modelId, providers, catalog, providerName = null) {
  const orderedProviders = providerName
    ? [...providers.filter((key) => catalog.providers[key].name === providerName),
       ...providers.filter((key) => catalog.providers[key].name !== providerName)]
    : providers;
  for (const key of orderedProviders) {
    const provider = catalog.providers[key];
    const model = provider.models.find(m => {
      const shortId = modelId.includes('/') ? modelId.split('/').pop() : modelId;
      return m.id === modelId || m.id.endsWith(shortId);
    });
    if (model) {
      return { provider: key, modelId: model.id };
    }
  }
  return null;
}

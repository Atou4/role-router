#!/usr/bin/env node

/**
 * Role Router interactive configuration CLI
 * Prompts user for their providers, API keys, proposes routing, lets them customize.
 * Outputs: ~/.claude-code-router/config.json + shell instructions
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, '../providers/catalog.json');
const OUTPUT_PATH = path.expanduser('~/.claude-code-router/config.json');

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
console.log(cyan('│  ⚠️  IMPORTANT: Claude Code Max (Architect) always      │'));
console.log(cyan('│     runs in vanilla context, never through CCR.        │'));
console.log(cyan('│                                                      │'));
console.log(cyan('└──────────────────────────────────────────────────────┘'));
console.log();

// Step 1: Select providers
console.log(bold('Which plans/providers do you currently have?'));
console.log(dim('☑ Claude Code Max    (Architect stays on vanilla — always selected)'));
console.log();

const providerOptions = [
  { key: 'openai', name: 'OpenAI Codex / GPT' },
  { key: 'zhipu', name: 'Zhipu GLM' },
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

if (selectedProviders.length === 0) {
  console.log(yellow('\n⚠ No providers selected. At minimum, you need one for Builder and Worker.'));
  console.log(dim('  If you only have Claude Max, you can still use /plan but the build steps need a provider.'));
  const continueAnyway = await question('\nContinue anyway? (y/N): ');
  if (continueAnyway.toLowerCase() !== 'y') {
    console.log(dim('\nSetup cancelled. Add a provider key when you have one.'));
    process.exit(0);
  }
}

// Step 2: Collect API keys
console.log();
console.log(bold('┌─ Collect API keys ───────────────────────────────┐'));
console.log();

const apiKeys = {};

for (const key of selectedProviders) {
  const provider = catalog.providers[key];
  const envName = provider.api_key_env;
  const currentValue = process.env[envName] ? dim('(already set in env)') : '';
  const answer = await question(`${provider.name} key ${currentValue}: `.trim() + ' ');
  if (answer && !process.env[envName]) {
    apiKeys[envName] = answer;
  }
}

// Step 3: Propose routing
console.log();
console.log(bold('┌─ Proposed configuration ───────────────────────────┐'));
console.log();

const proposedRouting = proposeRouting(selectedProviders, catalog);

console.log(dim('Based on what you have, here\'s a sane setup:'));
console.log();
console.log('┌─────────────────┬──────────────┬─────────────┐');
console.log('│ Role            │ Model        │ Provider    │');
console.log('├─────────────────┼──────────────┼─────────────┤');

for (const [role, entry] of Object.entries(proposedRouting)) {
  const roleDisplay = role.padEnd(15);
  const modelDisplay = (entry.model || '(none)').padEnd(12);
  const providerDisplay = (entry.provider || '').padEnd(11);
  console.log(`│ ${roleDisplay}│ ${modelDisplay}│ ${providerDisplay}│`);
}

console.log('└─────────────────┴──────────────┴─────────────┘');
console.log();

// Show costs summary
console.log(dim('Your costs:'));
console.log(dim('  • Architect uses your Max quota (free at margin)'));
if (proposedRouting.Builder.model) {
  console.log(dim(`  • Builder hits ${proposedRouting.Builder.provider}`));
}
if (proposedRouting.Worker.model) {
  console.log(dim(`  • Worker + Escalation hit ${proposedRouting.Worker.provider}`));
}
console.log();

const customize = await question(bold('[A]ccept  [C]ustomize models: ').toLowerCase());

let finalRouting = proposedRouting;

if (customize === 'c') {
  finalRouting = await customizeRouting(proposedRouting, selectedProviders, catalog);
}

// Step 4: Generate CCR config
console.log();
console.log(bold('┌─ Generating configuration ────────────────────────┐'));
console.log();

const config = generateCCRConfig(finalRouting, selectedProviders, apiKeys, catalog);

// Ensure directory exists
const configDir = path.dirname(OUTPUT_PATH);
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(config, null, 2));
console.log(green('✓ Config written to ~/.claude-code-router/config.json'));
console.log();

// Show shell instructions
console.log(bold('┌─ Shell exports ──────────────────────────────────┐'));
console.log();

if (Object.keys(apiKeys).length > 0) {
  console.log(dim('Add these to your ~/.zshrc or ~/.bash_profile:'));
  console.log();
  for (const [env, key] of Object.entries(apiKeys)) {
    console.log(`  export ${env}="${key}"`);
  }
  console.log();
  console.log(dim('Then run:  source ~/.zshrc  # or restart your shell'));
} else {
  console.log(dim('All keys are already in your environment. Good to go!'));
}
console.log();

console.log(bold('┌─ Next steps ────────────────────────────────────┐'));
console.log();
console.log(dim('  After setting the exports above, run:'));
console.log(green('    ccr restart'));
console.log();
console.log(dim('  Then start using Role Router:'));
console.log(dim('    claude            # → /plan <feature>    (Max)'));
console.log(dim('    ccr code          # → /build /review /docs'));
console.log();
console.log(dim('  See README.md for the full guide.'));
console.log();
console.log(cyan(bold('                    Setup complete!')));
console.log();

rl.close();

function proposeRouting(providers, catalog) {
  const routing = {
    Architect: { model: 'Claude Opus (Max)', provider: 'Max (vanilla)' },
    Builder: { model: null, provider: null },
    Worker: { model: null, provider: null },
    Escalation: { model: null, provider: null }
  };

  // Prefer OpenAI o3-mini for Builder if available
  if (providers.includes('openai')) {
    const o3mini = catalog.providers.openai.models.find(m => m.id === 'o3-mini');
    if (o3mini) {
      routing.Builder = { model: 'o3-mini', provider: 'OpenAI' };
    }
  }
  // Fall back to Zhipu GLM-5.2
  else if (providers.includes('zhipu')) {
    const glm = catalog.providers.zhipu.models.find(m => m.id === 'glm-5.2');
    if (glm) {
      routing.Builder = { model: 'glm-5.2', provider: 'Zhipu' };
    }
  }
  // Fall back to OpenRouter Kimi
  else if (providers.includes('openrouter')) {
    const kimi = catalog.providers.openrouter.models.find(m => m.id === 'moonshotai/kimi-k2.6');
    if (kimi) {
      routing.Builder = { model: 'kimi-k2.6', provider: 'OpenRouter' };
    }
  }

  // Prefer cheapest option for Worker
  if (providers.includes('openrouter')) {
    const flash = catalog.providers.openrouter.models.find(m => m.id === 'deepseek/deepseek-v4-flash');
    if (flash) {
      routing.Worker = { model: 'deepseek-v4-flash', provider: 'OpenRouter' };
    }
  }
  else if (providers.includes('zhipu')) {
    const glmFlash = catalog.providers.zhipu.models.find(m => m.id === 'glm-4-flash');
    if (glmFlash) {
      routing.Worker = { model: 'glm-4-flash', provider: 'Zhipu' };
    }
  }

  // Escalation defaults to the strongest available model
  if (providers.includes('anthropic')) {
    routing.Escalation = { model: 'claude-opus-4.8', provider: 'Anthropic (paid)' };
  }
  else if (providers.includes('openrouter') && routing.Builder.provider === 'OpenRouter') {
    // If on OpenRouter, use Claude Opus for escalation
    routing.Escalation = { model: 'claude-opus-4.8', provider: 'OpenRouter' };
  }
  else if (providers.includes('zhipu')) {
    routing.Escalation = { model: 'glm-5.2', provider: 'Zhipu' };
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

function generateCCRConfig(routing, providers, apiKeys, catalog) {
  const configProviders = [];
  const modelSet = new Set();

  // Map routing to CCR provider entries
  for (const key of providers) {
    const provider = catalog.providers[key];
    const models = [];

    // Add models that are used in routing
    for (const [role, entry] of Object.entries(routing)) {
      if (role === 'Architect') continue; // Never goes through CCR
      if (entry.provider === provider.name && entry.model) {
        // Find the model ID in catalog
        const modelEntry = provider.models.find(m => {
          const shortId = entry.model.includes('/') ? entry.model.split('/').pop() : entry.model;
          return m.id === entry.model || m.id.endsWith(shortId);
        });
        if (modelEntry && !modelSet.has(modelEntry.id)) {
          models.push(modelEntry.id);
          modelSet.add(modelEntry.id);
        }
      }
    }

    // Also add all models from the catalog for flexibility
    for (const model of provider.models) {
      if (!modelSet.has(model.id)) {
        models.push(model.id);
        modelSet.add(model.id);
      }
    }

    configProviders.push({
      name: key,
      api_base_url: provider.api_base_url,
      api_key: `\${${provider.api_key_env}}`,
      models,
      transformer: key === 'openrouter' ? { use: ['openrouter'] } : undefined
    });
  }

  // Build Router block
  const router = {
    default: null,
    background: null,
    think: null,
    longContext: null,
    longContextThreshold: 60000
  };

  // Map Builder to default
  if (routing.Builder.model) {
    const builderEntry = findProviderForModel(routing.Builder.model, providers, catalog);
    if (builderEntry) {
      router.default = `${builderEntry.provider},${builderEntry.modelId}`;
    }
  }

  // Map Worker to background
  if (routing.Worker.model) {
    const workerEntry = findProviderForModel(routing.Worker.model, providers, catalog);
    if (workerEntry) {
      router.background = `${workerEntry.provider},${workerEntry.modelId}`;
    }
  }

  // Map Escalation to longContext
  if (routing.Escalation.model) {
    const escalationEntry = findProviderForModel(routing.Escalation.model, providers, catalog);
    if (escalationEntry) {
      router.longContext = `${escalationEntry.provider},${escalationEntry.modelId}`;
    }
  }

  // Fallback think to default
  if (router.default) {
    router.think = router.default;
  }

  return {
    _comment: "Role Router CCR config — generated by scripts/configure.mjs. Architect runs in vanilla context, never through this file.",
    Providers: configProviders,
    Router: router
  };
}

function findProviderForModel(modelId, providers, catalog) {
  for (const key of providers) {
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

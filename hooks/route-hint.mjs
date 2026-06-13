#!/usr/bin/env node
/**
 * Role Router — Hint Hook (UserPromptSubmit)
 *
 * FREE, local, deterministic. Keyword-classifies the prompt and *suggests* a
 * Role command via systemMessage. It never switches Engines, never blocks the
 * prompt, and costs zero model tokens (the suggestion is shown to the user, not
 * injected into the model context).
 *
 * Wire up in settings.json:
 *   "hooks": { "UserPromptSubmit": [ { "hooks": [
 *     { "type": "command", "command": "node ~/.claude/hooks/route-hint.mjs" }
 *   ] } ] }
 */

const ROLES = [
  { role: 'Architect', cmd: '/plan',   engine: 'Claude / Max — VANILLA context',
    rx: /\b(plan|design|architect|architecture|rfc|prd|spec|decompose|break down|trade[- ]?off|migration|strategy|approach|should we|evaluate)\b/i },
  { role: 'Builder',   cmd: '/build',  engine: 'Kimi — CCR context',
    rx: /\b(build|implement|add|create|write|code|feature|component|refactor|fix|bug|endpoint|api|function|hook|screen|migration script)\b/i },
  { role: 'Worker',    cmd: '/review', engine: 'DeepSeek — CCR context',
    rx: /\b(review|audit|check|lint|docs?|document|changelog|release note|summar(y|ize)|pr body|postmortem|report|notes)\b/i },
];

function read(stream) {
  return new Promise((resolve) => {
    let d = '';
    stream.on('data', (c) => (d += c));
    stream.on('end', () => resolve(d));
    stream.on('error', () => resolve(''));
  });
}

(async () => {
  try {
    const raw = await read(process.stdin);
    const prompt = (() => { try { return JSON.parse(raw).prompt || ''; } catch { return raw; } })();

    // Already a slash command? Stay out of the way.
    if (/^\s*\//.test(prompt)) return process.exit(0);

    const score = ROLES
      .map((r) => ({ ...r, hits: (prompt.match(r.rx) || []).length }))
      .filter((r) => r.hits > 0)
      .sort((a, b) => b.hits - a.hits);

    if (score.length === 0) return process.exit(0);

    const top = score[0];
    const msg = `Role Router hint: this looks like ${top.role} work — consider ${top.cmd} (${top.engine}) to save Claude/Max quota. (Suggestion only; ignore if wrong.)`;
    process.stdout.write(JSON.stringify({ systemMessage: msg }));
    process.exit(0);
  } catch {
    // Never block a prompt on a hook error.
    process.exit(0);
  }
})();

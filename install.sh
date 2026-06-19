#!/usr/bin/env bash
set -euo pipefail

# Role Router installer — see CONTEXT.md and docs/adr/.
# Installs CCR, writes the CCR config, and copies Role commands + the Hint Hook
# into ~/.claude. Idempotent-ish: backs up an existing CCR config before writing.

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
CCR_DIR="$HOME/.claude-code-router"
CCR_CONFIG="$CCR_DIR/config.json"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m%s\033[0m\n' "$1"; }

bold "Role Router installer"
echo

# ── 1. The money-trap warning (ADR-0002) ───────────────────────────────────
warn "⚠  IMPORTANT — read before continuing:"
warn "   CCR authenticates with API KEYS, not your Claude Max subscription."
warn "   Any Claude Code traffic launched via 'ccr code' bills to the paid"
warn "   Anthropic API. There are documented cases of \$1000+ in surprise charges."
warn "   RULE: run /plan in a plain 'claude' session (Max). Only use 'ccr code'"
warn "   for /build, /review, /docs. The anthropic/* entry in the CCR config"
warn "   fires ONLY on Escalation and is billed to the API on purpose."
echo
read -r -p "Understood — continue? [y/N] " ans
[[ "${ans:-N}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
echo

# ── 2. Dependencies ─────────────────────────────────────────────────────────
command -v node >/dev/null || { echo "node is required. Install Node.js first."; exit 1; }

if ! command -v claude >/dev/null; then
  warn "Claude Code not found. Install with: npm i -g @anthropic-ai/claude-code"
fi

if ! command -v ccr >/dev/null; then
  bold "Installing claude-code-router…"
  npm install -g @musistudio/claude-code-router
else
  ok "ccr already installed ($(ccr -v 2>/dev/null || echo present))."
fi

# ── 3. OpenRouter key ───────────────────────────────────────────────────────
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  warn "OPENROUTER_API_KEY is not set in your environment."
  echo  "Add it to your shell profile (get a key at https://openrouter.ai/keys):"
  echo  '   export OPENROUTER_API_KEY="sk-or-..."'
  echo  "The CCR config references it as \${OPENROUTER_API_KEY}."
fi

# ── 4. CCR config ───────────────────────────────────────────────────────────
mkdir -p "$CCR_DIR"
if [[ -f "$CCR_CONFIG" ]]; then
  cp "$CCR_CONFIG" "$CCR_CONFIG.bak.$(date +%s)"
  warn "Existing CCR config backed up."
fi
cp "$SRC/ccr/config.template.json" "$CCR_CONFIG"
ok "Wrote $CCR_CONFIG (Builder=kimi-k2.6, Worker=deepseek-v4-flash)."

# ── 5. Claude commands + hook ───────────────────────────────────────────────
mkdir -p "$CLAUDE_DIR/commands" "$CLAUDE_DIR/hooks"
cp "$SRC/commands/"*.md "$CLAUDE_DIR/commands/"
cp "$SRC/hooks/route-hint.mjs" "$CLAUDE_DIR/hooks/"
chmod +x "$CLAUDE_DIR/hooks/route-hint.mjs"
ok "Installed /plan /build /review /docs /next and the Hint Hook into $CLAUDE_DIR."

cat <<'NOTE'

Almost done. Two manual steps:

  1. Enable the Hint Hook — add to ~/.claude/settings.json:
       "hooks": { "UserPromptSubmit": [ { "hooks": [
         { "type": "command", "command": "node ~/.claude/hooks/route-hint.mjs" }
       ] } ] }

  2. Apply the CCR config:  ccr restart

Workflow:
  • Plan:   plain  `claude`   → /plan <feature>     (Architect, Max quota)
  • Build:  `ccr code`        → /build TASK-XXX      (Builder, Kimi)
  • Review: `ccr code`        → /review TASK-XXX     (Worker, DeepSeek)
  • Docs:   `ccr code`        → /docs TASK-XXX       (Worker, DeepSeek)
  • Loop:   `ccr code`        → /next                (auto-pick + build→review→docs)

Swap Engines anytime by editing ~/.claude-code-router/config.json (ADR-0001).
NOTE
ok "Role Router installed."

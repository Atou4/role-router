#!/usr/bin/env bash
set -euo pipefail

# Role Router installer — interactive setup
# Guides you through selecting your providers, entering API keys, and generates
# a tailored CCR config. Then copies commands + hooks + drivers into ~/.claude.

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
CCR_DIR="$HOME/.claude-code-router"
CCR_CONFIG="$CCR_DIR/config.json"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

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

# ── 3. Interactive configuration ────────────────────────────────────────────
bold "Running interactive configuration…"
echo

node "$SRC/scripts/configure.mjs"

# Check if config was written
if [[ ! -f "$CCR_CONFIG" ]]; then
  warn "Configuration was not written. Aborting install."
  exit 1
fi

ok "Configuration written to $CCR_CONFIG"

# ── 4. Claude commands + hook ───────────────────────────────────────────────
mkdir -p "$CLAUDE_DIR/commands" "$CLAUDE_DIR/hooks" "$CLAUDE_DIR/role-router"
cp "$SRC/commands/"*.md "$CLAUDE_DIR/commands/"
cp "$SRC/hooks/route-hint.mjs" "$CLAUDE_DIR/hooks/"
cp "$SRC/scripts/fan-out.mjs" "$SRC/scripts/board.mjs" "$CLAUDE_DIR/role-router/"
chmod +x "$CLAUDE_DIR/hooks/route-hint.mjs" "$CLAUDE_DIR/role-router/fan-out.mjs" "$CLAUDE_DIR/role-router/board.mjs"
ok "Installed /plan /build /review /docs /next /fan-out, the Hint Hook, and the fan-out + board drivers into $CLAUDE_DIR."

# ── 5. Hook enable snippet ────────────────────────────────────────────────
echo
bold "Enable the Hint Hook"
echo
dim "Add this to ~/.claude/settings.json:"
echo
cat <<'EOF'
"hooks": { "UserPromptSubmit": [ { "hooks": [
  { "type": "command", "command": "node ~/.claude/hooks/route-hint.mjs" }
] } ] }
EOF
echo

# ── 6. Next steps ─────────────────────────────────────────────────────────
cat <<'NOTE'

┌─ Next steps ────────────────────────────────────┐

  1. Add the API key exports to your shell profile
     (printed by the configure script above).

  2. Apply the CCR config:
       ccr restart

  3. Start using Role Router:
       claude            # → /plan <feature>     (Max, vanilla)
       ccr code          # → /build /review /docs (cheap Engines)

Workflow:
  • Plan:   plain  `claude`   → /plan <feature>     (Architect, Max quota)
  • Build:  `ccr code`        → /build TASK-XXX      (Builder)
  • Review: `ccr code`        → /review TASK-XXX     (Worker)
  • Docs:   `ccr code`        → /docs TASK-XXX       (Worker)
  • Loop:   `ccr code`        → /next                (auto-pick)
  • Fanout: `ccr code`        → /fan-out TASK-A …B  (parallel)

See README.md for the full guide.
└───────────────────────────────────────────────────

NOTE
ok "Role Router installed."

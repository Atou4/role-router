#!/usr/bin/env bash
set -euo pipefail

# Role Router installer — interactive setup
# Guides you through selecting providers and generates direct Codex/OpenCode
# role bindings. Then copies commands + hooks + drivers into ~/.claude.

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"
ROLE_CONFIG="$HOME/.role-router/config.json"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

bold "Role Router installer"
echo

# ── 1. Authentication boundary ─────────────────────────────────────────────
warn "⚠  IMPORTANT — read before continuing:"
warn "   Codex Plus/Pro is launched through the signed-in Codex CLI."
warn "   API-backed roles launch through OpenCode and use provider API keys."
warn "   Review ~/.role-router/config.json before running unattended work."
echo
read -r -p "Understood — continue? [y/N] " ans
[[ "${ans:-N}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
echo

# ── 2. Dependencies ─────────────────────────────────────────────────────────
command -v node >/dev/null || { echo "node is required. Install Node.js first."; exit 1; }

if ! command -v claude >/dev/null; then
  warn "Claude Code not found. Install with: npm i -g @anthropic-ai/claude-code"
fi

if command -v codex >/dev/null; then
  ok "Codex CLI found ($(codex --version 2>/dev/null || echo present))."
else
  warn "Codex CLI not found. It is required only for Codex subscription roles."
fi

if ! command -v opencode >/dev/null; then
  bold "Installing OpenCode…"
  npm install -g --prefix "$HOME/.local" opencode-ai
else
  ok "OpenCode already installed ($(opencode --version 2>/dev/null || echo present))."
fi

# ── 3. Interactive configuration ────────────────────────────────────────────
bold "Running interactive configuration…"
echo

node "$SRC/scripts/configure.mjs"

# Check if config was written
if [[ ! -f "$ROLE_CONFIG" ]]; then
  warn "Role bindings were not written. Aborting install."
  exit 1
fi

ok "Role bindings written to $ROLE_CONFIG"

if node -e 'const c=require(process.argv[1]); process.exit(Object.values(c.roles || {}).some(r => r.adapter === "codex") ? 0 : 1)' "$ROLE_CONFIG"; then
  if ! codex login status >/dev/null 2>&1; then
    warn "Codex is selected but not signed in. Run: codex login"
  fi
fi

# ── 4. Self-contained runtime ──────────────────────────────────────────────
mkdir -p "$CLAUDE_DIR/role-router/commands" "$CLAUDE_DIR/role-router/providers" "$LOCAL_BIN"
cp "$SRC/commands/"*.md "$CLAUDE_DIR/role-router/commands/"
cp "$SRC/scripts/fan-out.mjs" "$SRC/scripts/board.mjs" "$SRC/scripts/run-role.mjs" "$SRC/scripts/configure.mjs" "$CLAUDE_DIR/role-router/"
cp "$SRC/providers/catalog.json" "$CLAUDE_DIR/role-router/providers/catalog.json"
chmod +x "$CLAUDE_DIR/role-router/fan-out.mjs" "$CLAUDE_DIR/role-router/board.mjs" "$CLAUDE_DIR/role-router/run-role.mjs" "$CLAUDE_DIR/role-router/configure.mjs"
cat > "$LOCAL_BIN/role-router" <<EOF
#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  run) shift; exec node "$CLAUDE_DIR/role-router/run-role.mjs" "\$@" ;;
  chat) shift; exec node "$CLAUDE_DIR/role-router/run-role.mjs" "\$@" --raw ;;
  configure) shift; exec node "$CLAUDE_DIR/role-router/configure.mjs" "\$@" ;;
  *) echo "Usage: role-router {configure|run <role> [argument]|chat <role> <message>}" >&2; exit 1 ;;
esac
EOF
chmod +x "$LOCAL_BIN/role-router"
ok "Installed the self-contained role runtime and $LOCAL_BIN/role-router."
case ":$PATH:" in
  *":$LOCAL_BIN:"*) ;;
  *) warn "$LOCAL_BIN is not on PATH. Add: export PATH=\"$LOCAL_BIN:\$PATH\"" ;;
esac

# ── 5. Next steps ─────────────────────────────────────────────────────────
cat <<'NOTE'

┌─ Next steps ────────────────────────────────────┐

  1. Add the API key exports to your shell profile
     (printed by the configure script above).

  2. Start using Role Router:
       role-router chat architect "inspect this codebase"
       role-router run architect "<feature>"
       role-router run builder TASK-001

Workflow:
  • Plan:   role-router run architect "<feature>"
  • Build:  role-router run builder TASK-XXX
  • Review: role-router run worker TASK-XXX
  • Docs:   role-router run docs TASK-XXX
  • Loop:   /next launches each configured Adapter   (auto-pick)
  • Fanout: fan-out.mjs launches the Builder Adapter (parallel)

See README.md for the full guide.
└───────────────────────────────────────────────────

NOTE
ok "Role Router installed."

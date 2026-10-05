#!/usr/bin/env bash
set -euo pipefail

# Role Router installer — interactive setup
# Detects Codex / Claude Code / OpenCode, asks which paid accounts and models to use,
# writes ~/.role-router/config.json (v2), then puts a
# `role-router` launcher on PATH that runs straight from this checkout.

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
warn "   Codex and Claude Code launch with their own paid-plan sign-ins."
warn "   API-backed roles launch through OpenCode and use provider API keys."
warn "   Review ~/.role-router/config.json before running unattended work."
echo
read -r -p "Understood — continue? [y/N] " ans
[[ "${ans:-N}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
echo

# ── 2. Dependencies ─────────────────────────────────────────────────────────
command -v node >/dev/null || { echo "node is required. Install Node.js first."; exit 1; }

for agent in codex claude; do
  if command -v "$agent" >/dev/null; then
    ok "$agent found ($("$agent" --version 2>/dev/null || echo present))."
  else
    warn "$agent not found. It is required only for roles bound to it."
  fi
done

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

if node -e 'const c=require(process.argv[1]); process.exit(Object.values(c.accounts || {}).some(a => a.agent === "codex") || Object.values(c.roles || {}).some(r => r.adapter === "codex") ? 0 : 1)' "$ROLE_CONFIG"; then
  if ! codex login status >/dev/null 2>&1; then
    warn "Codex is selected but not signed in. Run: codex login"
  fi
fi

# ── 4. Launcher ──────────────────────────────────────────────────────────────
mkdir -p "$LOCAL_BIN"
cat > "$LOCAL_BIN/role-router" <<EOF
#!/usr/bin/env bash
exec "$SRC/role-router" "\$@"
EOF
chmod +x "$LOCAL_BIN/role-router" "$SRC/role-router"
ok "Installed $LOCAL_BIN/role-router → $SRC/role-router."
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
  • Board:  role-router board list
  • Fanout: role-router fanout TASK-001 TASK-002   (parallel Builders)

See README.md for the full guide.
└───────────────────────────────────────────────────

NOTE
ok "Role Router installed."

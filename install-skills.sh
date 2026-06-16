#!/usr/bin/env bash
set -euo pipefail

# Install Role Router catalog skills from their ORIGINAL sources (no vendored
# bodies). Reads catalog/skills.json.
#
#   ./install-skills.sh                 # list domains
#   ./install-skills.sh all             # install every skill that has a remote source
#   ./install-skills.sh <domain> [...]  # install one or more domains
#   ./install-skills.sh <role:builder>  # install all skills for a role
#
# Skills marked "first-party (local)" have no remote source and are skipped
# (copy them from your own ~/.claude/skills). ui-ux-pro-max installs via the
# plugin marketplace; everything else via `npx skills add`.

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SRC/catalog/skills.json"
command -v node >/dev/null || { echo "node is required."; exit 1; }
[[ -f "$MANIFEST" ]] || { echo "Missing $MANIFEST"; exit 1; }

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

# Emit "domain<TAB>name<TAB>install" rows, filtered by selector (domain, all, or role:X).
rows() {
  node -e '
    const m = require(process.argv[1]);
    const sel = process.argv[2];
    for (const [dk, d] of Object.entries(m.domains)) {
      for (const s of d.skills) {
        const match = sel === "all" || sel === dk ||
          (sel.startsWith("role:") && s.role === sel.slice(5));
        if (!match) continue;
        const cmd = s.install || "";
        process.stdout.write([dk, s.name, cmd].join("\t") + "\n");
      }
    }
  ' "$MANIFEST" "$1"
}

if [[ $# -eq 0 ]]; then
  bold "Domains:"
  node -e 'const m=require(process.argv[1]); for(const [k,d] of Object.entries(m.domains)) console.log("  "+k+"  ("+d.skills.length+")  "+d.label);' "$MANIFEST"
  echo
  echo "Usage: ./install-skills.sh all | <domain> [domain...] | role:builder"
  exit 0
fi

selectors=("$@")
[[ "${1:-}" == "all" ]] && selectors=("all")

for sel in "${selectors[@]}"; do
  bold "── $sel ──"
  while IFS=$'\t' read -r domain name cmd; do
    [[ -z "${name:-}" ]] && continue
    if [[ "$cmd" == local:* || "$cmd" == "" ]]; then
      printf '  skip  %-34s (%s)\n' "$name" "${cmd:-no remote source}"
      continue
    fi
    printf '  install  %-30s\n' "$name"
    # The install string may contain && (plugin form); run it through a shell.
    if ! bash -c "$cmd"; then
      printf '  \033[33mfailed: %s — try the repo-level install (see catalog/README.md)\033[0m\n' "$name"
    fi
  done < <(rows "$sel")
done

bold "Done. Installed skills live in ~/.claude/skills."

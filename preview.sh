#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
original_config="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
original_cache="${XDG_CACHE_HOME:-$HOME/.cache}/opencode/npm"
preview=$(mktemp -d /tmp/opencode/codex-preview.XXXXXX)
trap 'rm -rf -- "$preview"' EXIT
mkdir -p "$preview"/{config/opencode,cache,data,state}
python3 - "$original_config" "$original_cache" "$root" "$preview/config/opencode/opencode.json" <<'PY'
import json, pathlib, sys
config, cache, root, output = map(pathlib.Path, sys.argv[1:])
agents = json.loads(config.read_text())["agents"]
claude = agents["claude"] if "claude" in agents else agents["opus"]
plugins = sorted(cache.glob("@openchamber/opencode-claude@1.7.0/*/node_modules/@openchamber/opencode-claude/package.json"))
if not plugins:
    raise SystemExit("The installed Claude plugin 1.7.0 is missing from the OpenCode npm cache.")
preview = {
    "default_agent": "codex",
    "agents": {
        "claude": claude,
        "sonnet-worker": agents["sonnet-worker"],
        "sol": agents["sol"],
        "terra-worker": agents["terra-worker"],
        "codex": {
            "mode": "primary",
            "description": "Local Codex CLI, read-only preview; Codex owns its tools.",
            "model": "codex-cli/gpt-6.2-sol",
            "permissions": [{"action": "*", "resource": "*", "effect": "deny"}],
        },
    },
    "plugins": [
        str(plugins[-1].parent),
        {"package": str(root), "options": {"directory": str(root / "demo")}},
    ],
}
output.write_text(json.dumps(preview))
PY
export XDG_CONFIG_HOME="$preview/config" XDG_CACHE_HOME="$preview/cache"
export XDG_DATA_HOME="$preview/data" XDG_STATE_HOME="$preview/state"
export OPENCODE_DB="$preview/opencode.db"
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
unset OPENCODE_SESSION_ID
cd -- "$root/demo"
if [[ ${1:-} == serve ]]; then
    [[ $# -eq 1 ]] || exit 2
    "${OPENCODE_BIN:-opencode}" serve --hostname 127.0.0.1 --port 0
else
    "${OPENCODE_BIN:-opencode}" --standalone "$@"
fi

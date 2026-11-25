# OpenCode plugins

This repository maintains two OpenCode 2 plugins as Git subtrees:

| Package | Location | Source |
| --- | --- | --- |
| Codex server bridge | `opencode-codex` | `ethicnology-agent/opencode-codex`, initial revision `d89559374e63467c732e363f07391213de78d749` |
| Codex Desktop UI | `opencode-codex/desktop` | Same revision as the server bridge |
| Claude Code bridge | `opencode-claude` | `ethicnology-agent/opencode-claude`, initially based on upstream tag `v1.7.0` (`2469721d0c0a98053b24694276c844c1f340b72c`) |

The Claude upstream now recommends OpenCode's native Claude Code integration. This repository retains the plugin for deployments that explicitly use it.

## Install or update

Clone `https://github.com/ethicnology-agent/opencode-plugins.git`. Use Bun 1.4.4 and the existing authenticated Claude Code and Codex CLIs. Run `git pull --ff-only` from the clone to update, then build the Claude plugin from its checked-in lockfile:

```sh
cd opencode-claude
bun install --frozen-lockfile --ignore-scripts
bun run build
```

Codex and its Desktop component require no build. In each OpenCode configuration, point `plugins` to the absolute package directories in that machine's clone. Replace old entries rather than loading duplicate plugin IDs. Keep existing plugin options, agent and provider settings, and credentials local. Put the `desktop` package in the global configuration of OpenCode Desktop's own server, not on a headless server.

After updating both hosts, compare `git rev-parse HEAD`. Reload OpenCode if the external plugin paths were not picked up automatically, then check `opencode plugin list` and `opencode models` from the intended project.

## Maintaining Claude

Keep the fork's `main` aligned with upstream and use topic branches for proposed upstream changes. Import a reviewed source revision into the monorepo with `git subtree merge --prefix=opencode-claude <revision>` after fetching it. Keep the MIT license and avoid publishing private monorepo content to the public fork.

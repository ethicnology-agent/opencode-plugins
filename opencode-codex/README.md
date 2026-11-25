# OpenCode Codex bridge and status pill

Experimental local OpenCode 2 plugin, two parts:

- **Server part** (`index.mjs`, loaded by the OpenCode server on azad-dev): exposes `codex-cli/gpt-6.2-sol`, whose turns run in the installed Codex CLI, and a `ethicnology.status` RPC with Claude/Codex subscription usage and host load.
- **Desktop part** (`desktop/`, loaded by OpenCode Desktop's own server on the laptop): a pill above the composer that calls the status RPC on the server of the open session.

## Codex bridge

- Codex owns its agent loop and tools, `danger-full-access` sandbox (full write and network access), no interactive approvals. OpenCode tools and permissions are not bridged; OpenCode shows the final text only.
- One Codex thread per OpenCode session while the server runs. The thread is resumed when OpenCode's visible history is what the thread produced, optionally followed by user messages only (interrupted or steered turns); those messages are resent. Any other change (agent switch, compaction, revert, fork, server restart) starts a new Codex thread seeded with the visible transcript (truncated to the last 400k characters).
- Compaction, title and other auxiliary requests run as one isolated `codex exec --ephemeral` turn.
- Usage reported to OpenCode is an estimate of the visible conversation, not Codex's cumulative per-turn usage, which triggered spurious compactions.
- Diagnostics: `OPENCODE_CODEX_TRACE=/path/file.jsonl` logs routing decisions (no message content); `OPENCODE_CODEX_TRACE_SHAPE=1` adds message roles and sizes.

## Status RPC

`POST /api/rpc/ethicnology.status/read?location[directory]=<dir>` with `{"input":{}}`. Usage is cached for 2 minutes; host load is read on every call.

- Claude: Claude Agent SDK `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` (5-hour and 7-day windows), through the Claude Code login, using the SDK shipped with the installed `@openchamber/opencode-claude` (override with the `claudeSdk` option). Experimental upstream: expect breakage on SDK updates; the pill then shows `Claude ?`.
- Codex: App Server `account/rateLimits/read` (weekly window).
- Host: CPU busy share between reads, `MemAvailable`, `melos.slice` headroom, free space on `/`. Warning below 10 GiB or at 90% CPU, danger below 5 GiB.
- Disable with plugin option `"status": false`.

## Codex subagent activity in Desktop

The Desktop plugin reads the active session's activity from its own server over RPC. The pill appears when the CLI reports a collaboration event. It shows the last reported state and action for each agent, and keeps the last turn's report visible for up to one minute. Prompts, tool output and thread identifiers are excluded. The CLI's JSON event stream can omit agent identifiers, so the pill falls back to the last reported action when individual agents cannot be identified.

Update both the server plugin and the Desktop-only package on the laptop. The Desktop application itself requires no changes.

## Tests

- `node --test` (Node 18): bridge, status pill and subagent activity.
- `python3 test/e2e-preview.py`: real Codex and Claude against a private OpenCode server; set `OPENCODE_BIN` to test another OpenCode binary, e.g. `~/.opencode/desktop-ssh/2.4.1/opencode`.
- `bash preview.sh`: interactive private instance with the `claude`, `codex` and `sol` agents.

Verified 2026-11-25 with OpenCode 2.4.1 (server) and 2.3.2 (CLI), Codex CLI 0.171.0, Claude Code 2.1.322. The desktop pill is unit-tested with stand-ins only; it has not run in OpenCode Desktop yet.

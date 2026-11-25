# OpenCode Codex bridge and status pill

Experimental local OpenCode 2 plugin, two parts:

- **Server part** (`index.mjs`, loaded by the OpenCode server on azad-dev): exposes `codex-cli/gpt-6.2-sol`, whose turns run in the installed Codex CLI, and a `ethicnology.status` RPC with Claude/Codex subscription usage and host load.
- **Desktop part** (`desktop/`, loaded by OpenCode Desktop's own server on the laptop): a pill above the composer that calls the status RPC on the server of the open session.

## Codex bridge

- Codex owns its agent loop and local tools, with `danger-full-access` and no interactive CLI approvals for primary turns. If OpenCode offers its `subagent` tool, Codex delegates through that native tool under OpenCode's subagent permissions. This path needs Node on the server's `PATH`, or an absolute executable path in the `nodeCommand` plugin option. OpenCode receives the final Codex text, not incremental text.
- A Codex thread resumes only when the visible history matches its last confirmed reply. An interruption or other divergence starts a new thread from the visible transcript (truncated to the last 400k characters), without automatically re-executing earlier requests. Request replay protection is in memory and does not survive a server restart.
- A tool result can continue its matching parked turn, but cannot start a new one if the turn is gone. Only an exact retry can replay an already-completed answer; changed system instructions cannot make a previous chat turn execute again.
- Auxiliary model calls use isolated, read-only `codex exec --ephemeral` turns. Title requests return a fixed title.
- Usage reported to OpenCode is an estimate of the visible conversation, not Codex's cumulative per-turn usage, which triggered spurious compactions.
- Diagnostics: `OPENCODE_CODEX_TRACE=/path/file.jsonl` logs routing decisions (no message content); `OPENCODE_CODEX_TRACE_SHAPE=1` adds message roles and sizes.

## Status RPC

`POST /api/rpc/ethicnology.status/read?location[directory]=<dir>` with `{"input":{}}`. Host load is read on every call without waiting for account usage. Usage is refreshed in the background, cached for 2 minutes, and marked pending until the first refresh completes.

- Claude: Claude Agent SDK `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` (5-hour and 7-day windows), through the Claude Code login, using the SDK shipped with the installed `@openchamber/opencode-claude` (override with the `claudeSdk` option). Experimental upstream: expect breakage on SDK updates; the pill then shows `Claude ?`.
- Codex: App Server `account/rateLimits/read` (weekly window).
- Host: CPU busy share between reads, `MemAvailable`, `melos.slice` headroom, free space on `/`. Warning below 10 GiB or at 90% CPU, danger below 5 GiB.
- Disable with plugin option `"status": false`.

## Codex subagent activity in Desktop

Native OpenCode subagents appear in OpenCode's own session UI. When no native subagent tool is offered, the Desktop pill reads Codex CLI collaboration activity from the session's server over RPC. It shows the last reported state and action for each agent, and keeps the last turn's report visible for up to one minute. Prompts, tool output and thread identifiers are excluded. The CLI's JSON event stream can omit agent identifiers, so the pill falls back to the last reported action when individual agents cannot be identified.

Update both the server plugin and the Desktop-only package on the laptop. The Desktop application itself requires no changes.

## Tests

- `node --test` (Node 18): bridge, status pill and subagent activity.
- `python3 test/e2e-preview.py`: real Codex and Claude against a private OpenCode server; set `OPENCODE_BIN` to test another OpenCode binary, e.g. `~/.opencode/desktop-ssh/2.4.1/opencode`.
- `bash preview.sh`: interactive private instance with the `claude`, `codex` and `sol` agents.

Verified 2026-11-25 with OpenCode 2.4.1 (server) and 2.3.2 (CLI), Codex CLI 0.171.0, Claude Code 2.1.322. The desktop pill is unit-tested with stand-ins only; it has not run in OpenCode Desktop yet.

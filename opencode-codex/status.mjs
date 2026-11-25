// Shared status snapshot (subscription usage + host load) exposed to clients over plugin RPC.
import { appendFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { formatUsage, readClaudeUsage, readCodexUsage } from "./usage.mjs";
import { createSystemSampler, formatSystem, systemTone } from "./system.mjs";

// Plain definition object: Rpc.define only validates and returns it.
export const StatusRpc = {
  id: "ethicnology.status",
  methods: {
    read: {
      input: { type: "object" },
      output: { type: "object" },
    },
  },
  events: {},
};

const usageTtl = 2 * 60 * 1000;
const sample = createSystemSampler();
sample().catch(() => {}); // CPU usage needs a baseline; take it as soon as the module loads.

async function claudeSdk(path) {
  if (path) return import(pathToFileURL(path).href);
  // Default: the SDK shipped with the installed opencode-claude plugin.
  const root = join(homedir(), ".cache/opencode/npm/@openchamber");
  for (const pkg of (await readdir(root)).filter(n => n.startsWith("opencode-claude@")).sort().reverse()) {
    for (const build of (await readdir(join(root, pkg))).sort().reverse()) {
      const sdk = join(root, pkg, build, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
      try { return await import(pathToFileURL(sdk).href); } catch {}
    }
  }
  throw new Error("Claude Agent SDK not found");
}

export function createStatusReader({
  sample,
  readClaude = (options, signal) => claudeSdk(options.claudeSdk).then(sdk => readClaudeUsage({ sdk, signal })),
  readCodex = (_options, signal) => readCodexUsage({ signal }),
  now = Date.now,
}) {
  let usage = { at: null, claude: null, codex: null, errors: {} };
  let refreshing;

  function refreshUsage(options) {
    refreshing ??= (async () => {
      const signal = AbortSignal.timeout(45_000);
      const [claude, codex] = await Promise.allSettled([
        Promise.resolve().then(() => readClaude(options, signal)),
        Promise.resolve().then(() => readCodex(options, signal)),
      ]);
      usage = {
        at: now(),
        claude: claude.status === "fulfilled" ? claude.value : usage.claude && { ...usage.claude, stale: true },
        codex: codex.status === "fulfilled" ? codex.value : usage.codex && { ...usage.codex, stale: true },
        errors: Object.fromEntries([["claude", claude], ["codex", codex]].filter(([, r]) => r.status === "rejected").map(([k, r]) => [k, String(r.reason?.message ?? r.reason)])),
      };
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  return async function readStatus(options = {}) {
    if (usage.at === null || now() - usage.at > usageTtl) void refreshUsage(options);
    const system = await sample();
    const snapshot = { ...usage, pending: usage.at === null && refreshing !== undefined };
    const usageTone = [snapshot.claude?.fiveHour, snapshot.claude?.weekly, snapshot.codex?.weekly]
      .some(w => w?.remaining != null && w.remaining <= 10) ? "warning" : undefined;
    const tone = systemTone(system) ?? usageTone ?? null;
    return {
      text: `${formatUsage(snapshot)} | ${formatSystem(system)}`,
      tone,
      detail: { usage: snapshot, system },
    };
  };
}

export const readStatus = createStatusReader({ sample });

export async function registerStatus(ctx, options = {}) {
  const debug = entry => {
    const file = process.env.OPENCODE_CODEX_TRACE;
    if (file) try { appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), status: entry })}\n`); } catch {}
  };
  debug({ rpc: typeof ctx.rpc, register: typeof ctx.rpc?.register, location: ctx.location?.directory });
  if (typeof ctx.rpc?.register !== "function") return undefined;
  try {
    const registration = await ctx.rpc.register(StatusRpc, {
      read: async () => {
        try {
          const result = await readStatus(options);
          debug({ read: "ok", text: result.text });
          return result;
        } catch (error) {
          debug({ readError: String(error?.stack ?? error).slice(0, 800) });
          throw error;
        }
      },
    });
    debug({ registered: registration ? Object.keys(registration) : null });
    return registration;
  } catch (error) {
    debug({ error: String(error?.message ?? error) });
    return undefined;
  }
}

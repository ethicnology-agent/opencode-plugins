// Subscription usage readers for the OpenCode status indicator.
// Each reader uses the vendor's own CLI login; no credential is read or copied here.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const remaining = used => (typeof used === "number" && Number.isFinite(used) ? Math.max(0, Math.round(100 - used)) : null);
const iso = value => (value == null ? null : new Date(typeof value === "number" ? (value > 1e12 ? value : value * 1000) : value).toISOString());

// Codex App Server `account/rateLimits/read` over stdio JSON-RPC.
export async function readCodexUsage({ signal, command = "codex" } = {}) {
  signal?.throwIfAborted();
  const proc = spawn(command, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], detached: true });
  const stop = () => { try { process.kill(-proc.pid, "SIGTERM"); } catch {} };
  proc.stdin.on("error", () => {});
  const pending = new Map();
  let failure;
  const fail = error => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  };
  const abort = () => { fail(signal.reason ?? new Error("Codex usage request aborted")); stop(); };
  signal?.addEventListener("abort", abort, { once: true });
  let next = 1;
  const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = message.id != null && pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message ?? "Codex app-server error")) : waiter.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    if (failure !== undefined) return reject(failure);
    const id = next++;
    pending.set(id, { resolve, reject });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  void once(proc, "close").then(() => fail(new Error("Codex app-server exited")), fail);
  try {
    await call("initialize", { clientInfo: { name: "opencode-codex-usage", version: "0.1.0" } });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    const result = await call("account/rateLimits/read", null);
    const snapshot = result?.rateLimits ?? {};
    const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
    // Weekly window = 7 days; fall back to the longest window reported.
    const weekly = windows.find(w => w.windowDurationMins === 10080) ?? windows.sort((a, b) => (b.windowDurationMins ?? 0) - (a.windowDurationMins ?? 0))[0];
    return { weekly: weekly ? { remaining: remaining(weekly.usedPercent), resetsAt: iso(weekly.resetsAt) } : null };
  } finally {
    signal?.removeEventListener("abort", abort);
    stop();
    lines.close();
  }
}

// Claude Agent SDK usage control request (EXPERIMENTAL in the SDK: may break on SDK updates).
export async function readClaudeUsage({ sdk, signal } = {}) {
  const { query } = sdk;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let release;
  const idle = new Promise(resolve => { release = resolve; });
  // Streaming input that never sends a user turn: no model call, only control requests.
  async function* prompt() { await idle; }
  const q = query({ prompt: prompt(), options: { abortController: controller, tools: [], settingSources: [], persistSession: false } });
  q[Symbol.asyncIterator]().next().catch(() => {});
  try {
    const method = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET ?? q.getUsage;
    if (typeof method !== "function") throw new Error("Claude SDK has no usage API");
    const usage = await method.call(q, { skipBehaviors: true });
    if (!usage?.rate_limits_available || !usage.rate_limits) throw new Error("Claude plan limits unavailable");
    const window = w => (w ? { remaining: remaining(w.utilization), resetsAt: iso(w.resets_at) } : null);
    return { fiveHour: window(usage.rate_limits.five_hour), weekly: window(usage.rate_limits.seven_day) };
  } finally {
    signal?.removeEventListener("abort", abort);
    release();
    controller.abort();
    try { q.close?.(); } catch {}
  }
}

export function formatUsage({ claude, codex }) {
  const pct = w => (w?.remaining == null ? "?" : `${w.remaining}%`);
  const parts = [];
  parts.push(claude ? `Claude 5h ${pct(claude.fiveHour)} · 7d ${pct(claude.weekly)}` : "Claude ?");
  parts.push(codex ? `Codex 7d ${pct(codex.weekly)}` : "Codex ?");
  return parts.join(" | ");
}

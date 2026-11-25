import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ActivityRpc, createActivity } from "./activity.mjs";
import { callPrefix, createDelegation } from "./delegation.mjs";
import { registerStatus } from "./status.mjs";

const providerID = "codex-cli";
const model = "gpt-6.2-sol";
const maxRequest = 32 * 1024 * 1024;
// Characters of visible history replayed when a Codex thread must be (re)seeded.
const maxSeed = 400_000;
const defaultDelegationTimeoutSeconds = 900;
const shimGraceSeconds = 15;
const mcpGraceSeconds = 30;

function delegationTimeout(value = defaultDelegationTimeoutSeconds) {
  if (!Number.isInteger(value) || value < 1 || value > 3600) {
    throw new RangeError("delegationTimeoutSeconds must be an integer from 1 to 3600");
  }
  return value;
}

function scheduleParkedExpiry(callback, delay) {
  const timer = setTimeout(callback, delay);
  timer.unref();
  return () => clearTimeout(timer);
}

// Optional diagnostics: set OPENCODE_CODEX_TRACE to a file path to log routing decisions (no message content).
function trace(entry) {
  const file = process.env.OPENCODE_CODEX_TRACE;
  if (!file) return;
  try { appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`); } catch {}
}

class IncompleteCodexTurn extends Error {
  constructor() {
    super("Codex closed its output before confirming that the turn completed. Check its output before retrying.");
  }
}

export function execTurn({
  cwd, prompt, thread, ephemeral = false, signal, delegationURL, nodeCommand = "node",
  delegationTimeoutSeconds = defaultDelegationTimeoutSeconds, onCollaboration,
}) {
  const args = [
    "exec", ...(thread ? ["resume"] : []), "--json", "--ignore-user-config",
    ...(ephemeral && !thread ? ["--ephemeral"] : []),
    "-c", ephemeral ? 'sandbox_mode="read-only"' : 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"',
    ...(delegationURL ? [
      "--disable", "multi_agent", "--disable", "multi_agent_v2",
      "-c", `mcp_servers.opencode.command=${JSON.stringify(nodeCommand)}`,
      "-c", `mcp_servers.opencode.args=${JSON.stringify([
        fileURLToPath(new URL("./subagent-mcp.mjs", import.meta.url)),
        delegationURL,
        String((delegationTimeoutSeconds + shimGraceSeconds) * 1000),
      ])}`,
      "-c", `mcp_servers.opencode.tool_timeout_sec=${delegationTimeoutSeconds + mcpGraceSeconds}`,
    ] : []),
    "-c", "features.hooks=false", "-m", model, "--skip-git-repo-check",
    ...(thread ? [thread] : []), "-",
  ];
  const proc = spawn("codex", args, { cwd, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  let processError;
  proc.on("error", error => { processError = error; });
  const completion = new Promise(resolve => proc.once("close", resolve));
  const terminate = (sig) => {
    if (!proc.pid) return;
    try { process.kill(-proc.pid, sig); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  let escalation;
  const stop = () => {
    if (escalation) return;
    terminate("SIGTERM");
    escalation = setTimeout(() => terminate("SIGKILL"), 1000);
    escalation.unref();
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  proc.stdin.on("error", () => {});
  proc.stdin.end(prompt);
  return (async () => {
    let id, usage, complete = false, failed = false;
    const messages = [];
    try {
      for await (const line of createInterface({ input: proc.stdout, crlfDelay: Infinity })) {
        let event;
        try { event = JSON.parse(line); }
        catch { continue; }
        if (event.type === "thread.started") id = event.thread_id;
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          messages.push(event.item.text);
        }
        if (event.item?.type === "collab_tool_call" &&
            ["item.started", "item.updated", "item.completed"].includes(event.type)) {
          onCollaboration?.(event.item);
        }
        if (event.type === "turn.completed") { complete = true; usage = event.usage; }
        if (event.type === "turn.failed") failed = true;
      }
      const code = await completion;
      if (signal.aborted) throw new Error("Codex interrupted");
      if (processError) throw processError;
      if (id && !complete && !failed) throw new IncompleteCodexTurn();
      if (code !== 0 || !complete || failed || !id || !messages.at(-1)) {
        throw new Error("Codex did not complete the turn; check the local CLI and its login");
      }
      if (thread && id !== thread) throw new Error("Codex returned a different thread");
      return { thread: id, text: messages.at(-1), usage };
    } catch (error) {
      if (proc.exitCode === null && proc.signalCode === null && proc.pid) stop();
      await completion;
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
      clearTimeout(escalation);
    }
  })();
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => typeof part === "string" ? part
    : part?.type === "text" && typeof part.text === "string" ? part.text
    : part?.type ? `[${part.type} omitted]` : "").join("\n");
}

// Flattens any chat history, including turns produced by another agent with tool calls,
// into text records. System and developer messages are kept as `instructions`.
export function conversation(messages) {
  if (!Array.isArray(messages)) throw new Error("Missing conversation");
  const records = [];
  for (const message of messages) {
    const role = message?.role;
    if (role === "tool" && message.tool_call_id?.startsWith(callPrefix)) continue;
    let text = contentText(message?.content).trim();
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = message.tool_calls.filter(call => !call.id?.startsWith(callPrefix)).map(call => `[tool call ${call?.function?.name ?? "unknown"}] ${call?.function?.arguments ?? ""}`.trim());
      text = [text, ...calls].filter(Boolean).join("\n");
    }
    if (!text) continue;
    if (role === "system" || role === "developer") records.push({ role: "instructions", text });
    else if (role === "tool") records.push({ role: "tool", text: `[tool result] ${text}` });
    else if (role === "user" || role === "assistant") records.push({ role, text });
  }
  return records;
}

export function transcript(records) {
  let body = records.map(({ role, text }) => `### ${role}\n${text}`).join("\n\n");
  if (body.length > maxSeed) body = `[earlier conversation truncated]\n\n${body.slice(-maxSeed)}`;
  return body;
}

function seededPrompt(prior, message) {
  return [
    "You are taking over a conversation that started in OpenCode, possibly with another agent or model.",
    "Its visible transcript follows. Tool calls shown in it were executed by the previous agent, not by you.",
    "Continue by answering the new user message only. Earlier requests may already have caused side effects, even when no answer is shown. Do not repeat their actions unless the new message explicitly asks you to.",
    "", "<transcript>", transcript(prior), "</transcript>", "", "New user message:", message,
  ].join("\n");
}

function oneShotPrompt(records) {
  const instructions = records.filter(({ role }) => role === "instructions").map(({ text }) => text).join("\n\n");
  const chat = records.filter(({ role }) => role !== "instructions");
  const last = chat.at(-1);
  const prior = last?.role === "user" ? chat.slice(0, -1) : chat;
  return [
    "Answer this single request directly from the material below. Do not use tools.",
    ...(instructions ? ["", "<instructions>", instructions, "</instructions>"] : []),
    ...(prior.length ? ["", "<transcript>", transcript(prior), "</transcript>"] : []),
    "", last?.role === "user" ? last.text : "Follow the instructions above.",
  ].join("\n");
}

class UncertainCodexTurn extends Error {
  constructor() {
    super("Codex may have already acted on this request. Check its effects before sending a new turn.");
  }
}

class ExpiredCodexContinuation extends Error {
  constructor() {
    super("This subagent result no longer has a pending Codex turn. Check the existing subagent result before continuing.");
  }
}

export function createBridge({
  cwd, execute = execTurn, nodeCommand, delegationTimeoutSeconds = defaultDelegationTimeoutSeconds,
  now = () => performance.now(), scheduleExpiry = scheduleParkedExpiry,
}) {
  const parkedTimeoutMs = delegationTimeout(delegationTimeoutSeconds) * 1000;
  const key = randomUUID();
  const sessions = new Map();
  const busy = new Map();
  const requests = new Map();
  const delegated = new Map();
  const endpoints = new Map();
  const activity = createActivity();
  const server = createServer(async (req, res) => {
    const delegation = endpoints.get(req.url);
    if (req.method !== "POST" || req.headers.origin ||
        (!delegation && (req.url !== "/v1/chat/completions" || req.headers["x-opencode-codex-key"] !== key))) {
      res.writeHead(404).end();
      return;
    }
    const controller = new AbortController();
    let turn;
    res.once("close", () => {
      if (!res.writableFinished || !turn?.parked) controller.abort();
      if (!res.writableFinished) turn?.controller.abort();
    });
    res.setHeader("connection", "close");
    let session, receipt, turnActivity;
    try {
      const parts = [];
      let total = 0;
      for await (const part of req) {
        total += part.length;
        if (total > maxRequest) { res.writeHead(413).end(); return; }
        parts.push(part);
      }
      const body = JSON.parse(Buffer.concat(parts));
      if (controller.signal.aborted || res.destroyed) return;
      if (delegation) {
        const result = await delegation.request(body);
        if (res.destroyed) return;
        if (!result) { res.writeHead(400).end(); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      const kind = req.headers["x-opencode-codex-kind"];
      const records = conversation(body.messages);
      if (process.env.OPENCODE_CODEX_TRACE_SHAPE) {
        trace({ kind, shape: (body.messages ?? []).map(m => `${m.role}:${JSON.stringify(m.content ?? "").length}`) });
      }
      let result, calls;
      if (kind === "title") {
        result = { text: "Codex CLI" };
      } else if (kind !== "primary") {
        // Compaction, generation and other auxiliary requests: one isolated Codex turn,
        // never attached to the session's thread.
        if (!records.some(({ role }) => role !== "instructions")) throw new Error(`Empty ${kind ?? "auxiliary"} request`);
        trace({ kind, session: req.headers["x-opencode-codex-session"], mode: "one-shot", records: records.length });
        result = await execute({ cwd, prompt: oneShotPrompt(records), ephemeral: true, signal: controller.signal });
        if (controller.signal.aborted) throw new Error("Codex interrupted");
      } else {
        const history = records.filter(({ role }) => role !== "instructions");
        session = req.headers["x-opencode-codex-session"];
        if (!session) throw new Error("Missing OpenCode session");
        // Instruction changes do not create a new turn, but invalidate exact answer replay.
        const chat = body.messages.filter(message => message?.role !== "system" && message?.role !== "developer");
        const turnKey = createHash("sha256").update(JSON.stringify([session, chat])).digest("hex");
        const fingerprint = createHash("sha256").update(JSON.stringify([body.messages, body.tools])).digest("hex");
        const recorded = requests.get(turnKey);
        const parked = delegated.get(session);
        if (parked?.parked && now() >= parked.parkDeadline) expireDelegation(parked);
        if (recorded?.result && recorded.fingerprint === fingerprint) {
          result = recorded.result;
        } else if (recorded) {
          throw new UncertainCodexTurn();
        } else if (parked?.parked && !parked.controller.signal.aborted && parked.delegation.accept(body.messages)) {
          receipt = { fingerprint };
          requests.set(turnKey, receipt);
          turn = parked;
          turn.parked = false;
          turn.cancelExpiry?.();
          turn.cancelExpiry = undefined;
          ({ result, calls } = await nextDelegated(turn));
          if (result) sessions.set(session, {
            thread: result.thread, history: [...history, { role: "assistant", text: result.text.trim() }],
          });
        } else {
          const latest = chat.at(-1);
          if (latest?.role === "tool" && latest.tool_call_id?.startsWith(callPrefix)) {
            throw new ExpiredCodexContinuation();
          }
          const last = history.at(-1);
          if (latest?.role !== "user" || last?.role !== "user") {
            throw new Error("Expected a new user turn or pending OpenCode tool result");
          }
          if (busy.has(session)) { session = undefined; throw new Error("Missing or busy OpenCode session"); }
          const previous = sessions.get(session);
          const prior = history.slice(0, -1);
          // A thread is resumable only after a confirmed, visible reply.
          const resumable = previous && JSON.stringify(prior) === JSON.stringify(previous.history);
          const prompt = resumable || !prior.length ? last.text : seededPrompt(prior, last.text);
          const thread = resumable ? previous.thread : undefined;
          trace({ kind, session, mode: resumable ? "resume" : prior.length ? "seed" : "new", prior: prior.length });
          sessions.delete(session);
          receipt = { fingerprint };
          requests.set(turnKey, receipt);
          busy.set(session, controller);
          const tool = body.tools?.find(item => item.type === "function" && item.function?.name === "subagent")?.function;
          if (tool?.parameters && server.address()) {
            const route = `/mcp/${randomUUID()}`;
            const bridge = createDelegation(tool, controller.signal);
            endpoints.set(route, bridge);
            turn = { controller, delegation: bridge, route };
            delegated.set(session, turn);
            controller.signal.addEventListener("abort", () => finishDelegation(session, turn), { once: true });
            turn.execution = Promise.resolve().then(() => execute({
              cwd, thread, signal: controller.signal, nodeCommand, delegationTimeoutSeconds,
              prompt: "Use the OpenCode subagent tool for delegation. Follow its instructions for background results.\n\n" + prompt,
              delegationURL: `http://127.0.0.1:${server.address().port}${route}`,
            })).then(result => ({ result }), error => ({ error }));
            ({ result, calls } = await nextDelegated(turn));
          } else {
            // Native OpenCode subagents have their own activity UI. Only report CLI collaboration.
            turnActivity = activity.start(session);
            result = await execute({ cwd, prompt, thread, signal: controller.signal, onCollaboration: turnActivity.record });
          }
          if (controller.signal.aborted) throw new Error("Codex interrupted");
          if (result) sessions.set(session, { thread: result.thread, history: [...history, { role: "assistant", text: result.text.trim() }] });
        }
      }
      if (receipt && result) receipt.result = result;
      const id = `chatcmpl-${randomUUID()}`;
      const common = { id, created: Math.floor(Date.now() / 1000), model };
      // Codex reports usage summed over every model call of the turn, including its own tool
      // loop; forwarding it makes OpenCode believe the context is full and compact needlessly,
      // which also discards the Codex thread. Report the visible conversation size instead.
      const visible = records.filter(({ role }) => role !== "instructions").reduce((sum, { text }) => sum + text.length, 0);
      const prompt_tokens = Math.ceil(visible / 4);
      const completion_tokens = Math.ceil((result?.text.length ?? 0) / 4);
      const usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
      const finish = calls ? "tool_calls" : "stop";
      if (body.stream) {
        const delta = calls
          ? { role: "assistant", tool_calls: calls.map((call, index) => ({ ...call, index })) }
          : { role: "assistant", content: result.text };
        const chunks = [[delta, null], [{}, finish]]
          .map(([delta, reason]) => ({ ...common, object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason: reason }] }));
        chunks.push({ ...common, object: "chat.completion.chunk", choices: [], usage });
        const payload = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
          "data: [DONE]\n\n";
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...common, object: "chat.completion", usage,
          choices: [{ index: 0, message: { role: "assistant", content: result?.text ?? null, ...(calls && { tool_calls: calls }) }, finish_reason: finish }] }));
      }
    } catch (error) {
      trace({ error: error.message });
      if (!res.destroyed) {
        res.writeHead(400, { "content-type": "application/json" });
        const type = error instanceof IncompleteCodexTurn ? "codex_incomplete_turn"
          : error instanceof UncertainCodexTurn ? "codex_uncertain_turn"
          : error instanceof ExpiredCodexContinuation ? "codex_expired_continuation" : "invalid_request_error";
        res.end(JSON.stringify({ error: { message: error.message, type } }));
      }
    } finally {
      if (turn && !turn.parked) await finishDelegation(session, turn);
      else if (!turn && session && busy.get(session) === controller) {
        turnActivity?.finish();
        busy.delete(session);
      }
    }
  });
  function expireDelegation(turn) {
    turn.controller.abort(new DOMException("OpenCode delegation timed out", "TimeoutError"));
  }

  async function finishDelegation(session, turn) {
    turn.cancelExpiry?.();
    turn.cancelExpiry = undefined;
    endpoints.delete(turn.route);
    turn.delegation.close();
    await turn.execution;
    if (delegated.get(session) !== turn) return;
    delegated.delete(session);
    busy.delete(session);
  }

  async function nextDelegated(turn) {
    const outcome = await turn.delegation.next(turn.execution);
    if (turn.controller.signal.aborted) throw new Error("Codex interrupted");
    if (outcome.error) throw outcome.error;
    if (outcome.calls) {
      const current = now();
      turn.parkDeadline ??= current + parkedTimeoutMs;
      const remaining = turn.parkDeadline - current;
      if (remaining <= 0) {
        expireDelegation(turn);
        throw turn.controller.signal.reason;
      }
      turn.parked = true;
      turn.cancelExpiry = scheduleExpiry(() => expireDelegation(turn), remaining);
    }
    return outcome;
  }

  return {
    key, server, activity: activity.read,
    interrupt(session) { busy.get(session)?.abort(); },
    close() {
      for (const request of busy.values()) request.abort();
      server.closeAllConnections();
      server.close();
    },
  };
}

export default {
  id: "ethicnology.codex-cli-preview",
  async setup(ctx) {
    const delegationTimeoutSeconds = delegationTimeout(ctx.options?.delegationTimeoutSeconds);
    // Status RPC (usage + host load) is independent of the Codex bridge; opt out with { status: false }.
    const status = ctx.options?.status === false ? undefined : await registerStatus(ctx, ctx.options ?? {});
    const disposeStatus = () => {
      try { (status?.dispose ?? status?.[Symbol.dispose] ?? status?.[Symbol.asyncDispose])?.call(status); } catch {}
    };
    const cwd = await realpath(ctx.location.directory);
    if (ctx.options?.allowAllDirectories !== true &&
        (!ctx.options?.directory || cwd !== await realpath(ctx.options.directory))) return disposeStatus;
    const nodeCommand = typeof ctx.options?.nodeCommand === "string" ? ctx.options.nodeCommand : undefined;
    const bridge = createBridge({ cwd, nodeCommand, delegationTimeoutSeconds });
    bridge.server.listen(0, "127.0.0.1");
    await once(bridge.server, "listening");
    const baseURL = `http://127.0.0.1:${bridge.server.address().port}/v1`;
    let activityRegistration;
    const close = async () => {
      bridge.close();
      disposeStatus();
      await activityRegistration?.dispose();
    };
    try {
      if (typeof ctx.rpc?.register === "function") {
        try {
          activityRegistration = await ctx.rpc.register(ActivityRpc, {
            read: async ({ sessionID }) => bridge.activity(sessionID),
          });
        } catch (error) {
          trace({ activityRegistrationError: error.message });
        }
      }
      await ctx.provider.transform(editor => editor.add({
        info: {
          id: providerID, name: "Codex CLI (preview)", activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL, provider: providerID, apiKey: "local-bridge" },
        },
        models: [{
          id: model, modelID: model, providerID, name: "Codex CLI / GPT-6.2 Sol",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true,
          limit: { context: 128000, output: 16000 },
        }],
      }));
      await ctx.session.hook("model.request", request => {
        request.baseURL = baseURL;
        request.headers["x-opencode-codex-key"] = bridge.key;
        request.headers["x-opencode-codex-kind"] = request.kind;
        if (request.sessionID) request.headers["x-opencode-codex-session"] = request.sessionID;
      }, { providerID });
      // OpenCode 2.4.1 emits session-wide interruption events without identifying the
      // execution. A delayed event could cancel a later turn. Use the owning response
      // connection for cancellation and the delegation timeout while between requests.
      return close;
    } catch (error) {
      await close();
      throw error;
    }
  },
};

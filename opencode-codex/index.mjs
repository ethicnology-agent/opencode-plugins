import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ActivityRpc, createActivity } from "./activity.mjs";
import { registerStatus } from "./status.mjs";

const providerID = "codex-cli";
const model = "gpt-6.2-sol";
const maxRequest = 32 * 1024 * 1024;
// Characters of visible history replayed when a Codex thread must be (re)seeded.
const maxSeed = 400_000;

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

export function execTurn({ cwd, prompt, thread, ephemeral = false, signal, onCollaboration }) {
  const args = [
    "exec", ...(thread ? ["resume"] : []), "--json", "--ignore-user-config",
    ...(ephemeral && !thread ? ["--ephemeral"] : []),
    "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"',
    "-c", "features.hooks=false", "-m", model, "--skip-git-repo-check",
    ...(thread ? [thread] : []), "-",
  ];
  const proc = spawn("codex", args, { cwd, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const completion = once(proc, "close");
  // Attach a rejection handler immediately; the spawn can fail before stdout closes.
  completion.catch(() => {});
  const terminate = (sig) => {
    if (!proc.pid) return;
    try { process.kill(-proc.pid, sig); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  let escalation;
  const stop = () => {
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
      const [code] = await completion;
      if (signal.aborted) throw new Error("Codex interrupted");
      if (id && !complete && !failed) throw new IncompleteCodexTurn();
      if (code !== 0 || !complete || failed || !id || !messages.at(-1)) {
        throw new Error("Codex did not complete the turn; check the local CLI and its login");
      }
      if (thread && id !== thread) throw new Error("Codex returned a different thread");
      return { thread: id, text: messages.at(-1), usage };
    } finally {
      signal.removeEventListener("abort", stop);
      if (escalation && !signal.aborted) clearTimeout(escalation);
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
    let text = contentText(message?.content).trim();
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = message.tool_calls.map(call => `[tool call ${call?.function?.name ?? "unknown"}] ${call?.function?.arguments ?? ""}`.trim());
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
    "Continue the conversation by answering the new user message.",
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

export function createBridge({ cwd, execute = execTurn }) {
  const key = randomUUID();
  const sessions = new Map();
  const busy = new Map();
  const activity = createActivity();
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions" ||
        req.headers.origin || req.headers["x-opencode-codex-key"] !== key) {
      res.writeHead(404).end();
      return;
    }
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    res.setHeader("connection", "close");
    let session, turnActivity;
    try {
      const parts = [];
      let total = 0;
      for await (const part of req) {
        total += part.length;
        if (total > maxRequest) { res.writeHead(413).end(); return; }
        parts.push(part);
      }
      const body = JSON.parse(Buffer.concat(parts));
      const kind = req.headers["x-opencode-codex-kind"];
      const records = conversation(body.messages);
      if (process.env.OPENCODE_CODEX_TRACE_SHAPE) {
        trace({ kind, shape: (body.messages ?? []).map(m => `${m.role}:${JSON.stringify(m.content ?? "").length}`) });
      }
      let result;
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
        const last = history.at(-1);
        if (last?.role !== "user") throw new Error("Expected a new user turn");
        session = req.headers["x-opencode-codex-session"];
        if (!session || busy.has(session)) { session = undefined; throw new Error("Missing or busy OpenCode session"); }
        const previous = sessions.get(session);
        const prior = history.slice(0, -1);
        // Resume when OpenCode's visible history is what this thread produced, possibly followed by
        // user messages only (an interrupted or steered turn). Otherwise (agent switch, compaction,
        // edit, fork, bridge restart) start a new Codex thread seeded with the visible transcript.
        const known = previous?.history ?? [];
        const extendsThread = previous && prior.length >= known.length &&
          JSON.stringify(prior.slice(0, known.length)) === JSON.stringify(known) &&
          prior.slice(known.length).every(({ role }) => role === "user");
        const pending = extendsThread ? prior.slice(known.length) : [];
        const prompt = extendsThread
          ? pending.length
            ? ["Messages sent since your last reply (an earlier turn may have been interrupted):",
                ...pending.map(({ text }) => text), "", "Latest message:", last.text].join("\n")
            : last.text
          : prior.length ? seededPrompt(prior, last.text) : last.text;
        const thread = extendsThread ? previous.thread : undefined;
        trace({ kind, session, mode: extendsThread ? (pending.length ? "resume-pending" : "resume") : prior.length ? "seed" : "new", prior: prior.length });
        sessions.delete(session);
        busy.set(session, controller);
        turnActivity = activity.start(session);
        try {
          result = await execute({
            cwd, prompt, thread, signal: controller.signal, onCollaboration: turnActivity.record,
          });
          if (controller.signal.aborted) throw new Error("Codex interrupted");
        } catch (error) {
          // Keep the thread for a resumed turn: the next turn resends every user message since the
          // last confirmed reply. A failed first turn has no confirmed thread and reseeds instead.
          if (thread) sessions.set(session, { thread, history: known });
          throw error;
        }
        sessions.set(session, { thread: result.thread, history: [...history, { role: "assistant", text: result.text.trim() }] });
      }
      const id = `chatcmpl-${randomUUID()}`;
      const common = { id, created: Math.floor(Date.now() / 1000), model };
      // Codex reports usage summed over every model call of the turn, including its own tool
      // loop; forwarding it makes OpenCode believe the context is full and compact needlessly,
      // which also discards the Codex thread. Report the visible conversation size instead.
      const visible = records.filter(({ role }) => role !== "instructions").reduce((sum, { text }) => sum + text.length, 0);
      const prompt_tokens = Math.ceil(visible / 4);
      const completion_tokens = Math.ceil(result.text.length / 4);
      const usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
      if (body.stream) {
        const chunks = [[{ role: "assistant", content: result.text }, null], [{}, "stop"]]
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
          choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }] }));
      }
    } catch (error) {
      trace({ error: error.message });
      if (!res.destroyed) {
        res.writeHead(400, { "content-type": "application/json" });
        const type = error instanceof IncompleteCodexTurn ? "codex_incomplete_turn" : "invalid_request_error";
        res.end(JSON.stringify({ error: { message: error.message, type } }));
      }
    } finally {
      if (session && busy.get(session) === controller) {
        turnActivity.finish();
        busy.delete(session);
      }
    }
  });
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
    // Status RPC (usage + host load) is independent of the Codex bridge; opt out with { status: false }.
    const status = ctx.options?.status === false ? undefined : await registerStatus(ctx, ctx.options ?? {});
    const disposeStatus = () => {
      try { (status?.dispose ?? status?.[Symbol.dispose] ?? status?.[Symbol.asyncDispose])?.call(status); } catch {}
    };
    const cwd = await realpath(ctx.location.directory);
    if (ctx.options?.allowAllDirectories !== true &&
        (!ctx.options?.directory || cwd !== await realpath(ctx.options.directory))) return disposeStatus;
    const bridge = createBridge({ cwd });
    bridge.server.listen(0, "127.0.0.1");
    await once(bridge.server, "listening");
    const baseURL = `http://127.0.0.1:${bridge.server.address().port}/v1`;
    const events = new AbortController();
    let activityRegistration;
    const close = async () => {
      events.abort();
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
          capabilities: { tools: false, input: ["text"], output: ["text"] },
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
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event.type === "session.execution.interrupted" || event.type === "session.execution.failed") {
            bridge.interrupt(event.data?.sessionID);
          }
        }
      })().catch(() => {});
      return close;
    } catch (error) {
      await close();
      throw error;
    }
  },
};

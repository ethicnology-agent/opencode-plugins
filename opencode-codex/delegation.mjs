import { randomUUID } from "node:crypto";

export const callPrefix = "call_opencode_";

export function createDelegation(tool, signal) {
  const pending = new Map();
  let notify;
  let changed = new Promise(resolve => { notify = resolve; });
  const update = () => {
    notify();
    changed = new Promise(resolve => { notify = resolve; });
  };
  const abort = () => {
    for (const { resolve } of pending.values()) {
      resolve({ isError: true, content: [{ type: "text", text: "OpenCode turn interrupted" }] });
    }
    pending.clear();
    update();
  };
  signal.addEventListener("abort", abort, { once: true });

  return {
    async request({ method, params }) {
      if (method === "tools/list") {
        return { tools: [{ name: tool.name, description: tool.description ?? "", inputSchema: tool.parameters }] };
      }
      if (method !== "tools/call" || params?.name !== tool.name || signal.aborted) return;
      const id = callPrefix + randomUUID().replaceAll("-", "");
      return new Promise(resolve => {
        pending.set(id, {
          resolve,
          call: { id, type: "function", function: { name: tool.name, arguments: JSON.stringify(params.arguments ?? {}) } },
        });
        update();
      });
    },
    accept(messages) {
      let accepted = false;
      for (const message of messages) {
        const entry = message.role === "tool" && pending.get(message.tool_call_id);
        if (!entry) continue;
        pending.delete(message.tool_call_id);
        const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
        entry.resolve({ content: [{ type: "text", text }] });
        accepted = true;
      }
      return accepted;
    },
    async next(execution) {
      while (!signal.aborted) {
        if (pending.size) return { calls: [...pending.values()].map(entry => entry.call) };
        const outcome = await Promise.race([execution, changed]);
        if (outcome) return outcome;
      }
      return { error: new Error("Codex interrupted") };
    },
    close() {
      signal.removeEventListener("abort", abort);
      abort();
    },
  };
}

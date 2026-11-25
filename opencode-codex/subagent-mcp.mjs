// Codex connects to this stdio MCP process. The bridge holds the call while
// OpenCode runs its native subagent tool and returns the result.
import { createInterface } from "node:readline";

const endpoint = process.argv[2];

async function respond({ method, params, id }) {
  if (id === undefined) return;
  let result;
  try {
    if (method === "initialize") {
      result = {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "opencode", version: "1" },
      };
    } else if (method === "ping") {
      result = {};
    } else if (method === "tools/list" || method === "tools/call") {
      const response = await fetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ method, params }),
      });
      if (!response.ok) throw new Error("OpenCode delegation is unavailable");
      result = await response.json();
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  } catch {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id, error: { code: -32603, message: "OpenCode delegation is unavailable" },
    }) + "\n");
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  void respond(request);
}

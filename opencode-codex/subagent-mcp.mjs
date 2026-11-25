// Codex connects to this stdio MCP process. The bridge holds the call while
// OpenCode runs its native subagent tool and returns the result.
import { request } from "node:http";
import { createInterface } from "node:readline";

const endpoint = new URL(process.argv[2]);
const timeoutMs = Number(process.argv[3]);
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
  throw new Error("Invalid OpenCode delegation endpoint or timeout");
}

// Node's fetch imposes a separate five-minute timeout on the silent loopback hop.
function send(message) {
  const body = JSON.stringify(message);
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const req = request(endpoint, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, async res => {
      try {
        if (res.statusCode !== 200) {
          res.resume();
          throw new Error("OpenCode delegation is unavailable");
        }
        const parts = [];
        for await (const part of res) parts.push(part);
        resolve(JSON.parse(Buffer.concat(parts)));
      } catch (error) { reject(signal.aborted ? signal.reason : error); }
    });
    req.on("error", error => reject(signal.aborted ? signal.reason : error));
    req.end(body);
  });
}

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
      result = await send({ method, params });
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id, error: { code: -32603, message: error?.name === "TimeoutError"
        ? "OpenCode delegation timed out" : "OpenCode delegation is unavailable" },
    }) + "\n");
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  void respond(request);
}

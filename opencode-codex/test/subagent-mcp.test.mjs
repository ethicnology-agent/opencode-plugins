import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

async function call(t, handler, timeoutMs) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp/fixture`;
  const script = fileURLToPath(new URL('../subagent-mcp.mjs', import.meta.url));
  const proc = spawn(process.execPath, [script, endpoint, String(timeoutMs)], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => proc.kill());
  const lines = createInterface({ input: proc.stdout });
  const answer = once(lines, 'line');
  proc.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'subagent' } }) + '\n');
  return JSON.parse((await answer)[0]);
}

test('the MCP shim forwards the JSON result over the loopback hop', { timeout: 2000 }, async t => {
  const content = [{ type: 'text', text: 'Test result' }];
  const answer = await call(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ content }));
  }, 500);
  assert.deepEqual(answer, { jsonrpc: '2.0', id: 1, result: { content } });
});

test('the MCP shim aborts a waiting response at its own absolute deadline', { timeout: 2000 }, async t => {
  const answer = await call(t, (req, res) => {
    req.resume();
    // Even receiving headers and some bytes must not reset the absolute timeout.
    res.writeHead(200, { 'content-type': 'application/json' }).write('{');
  }, 100);
  assert.deepEqual(answer, {
    jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'OpenCode delegation timed out' },
  });
});

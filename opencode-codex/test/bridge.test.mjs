import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../index.mjs';

async function start(t, execute) {
  const bridge = createBridge({ cwd: '/tmp', execute });
  bridge.server.listen(0, '127.0.0.1');
  await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}/v1/chat/completions`;
  function post(messages, options = {}) {
    return fetch(options.url ?? url, {
      method: options.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opencode-codex-key': bridge.key,
        'x-opencode-codex-session': 'session-1',
        'x-opencode-codex-kind': 'primary',
        ...options.headers,
      },
      body: JSON.stringify({ messages, tools: options.tools, stream: options.stream ?? false }),
      signal: options.signal,
    });
  }
  return { bridge, post, url };
}

const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });

function pendingExecution() {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const execute = ({ signal }) => {
    calls++;
    entered(signal);
    return new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error('interrupted'));
      else signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
    });
  };
  return { execute, started, get calls() { return calls; } };
}

test('HTTP completion forwards a turn and returns an OpenAI-compatible response', async t => {
  const calls = [];
  const { post } = await start(t, async args => {
    calls.push(args);
    return { thread: 'thread-1', text: 'Hello', usage: { input_tokens: 2, output_tokens: 3 } };
  });
  const response = await post([{ role: 'system', content: 'ignored' }, user('  Hi  ')]);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'Hello');
  // Visible-size estimate, not Codex's cumulative turn usage.
  assert.deepEqual(body.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/tmp');
  assert.equal(calls[0].prompt, 'Hi');
  assert.equal(calls[0].thread, undefined);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('a CLI stream ending before turn.completed returns an explicit HTTP error', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-incomplete-'));
  const path = process.env.PATH;
  t.after(async () => {
    process.env.PATH = path;
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, 'codex'), [
    '#!/bin/sh',
    'cat >/dev/null',
    `echo '{"type":"thread.started","thread_id":"thread-1"}'`,
    `echo '{"type":"item.completed","item":{"type":"agent_message","text":"Partial answer"}}'`,
  ].join('\n'), { mode: 0o700 });
  process.env.PATH = `${cwd}:${path}`;

  const { post } = await start(t);
  const response = await post([user('Hi')], { stream: true });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual((await response.json()).error, {
    type: 'codex_incomplete_turn',
    message: 'Codex closed its output before confirming that the turn completed. Check its output before retrying.',
  });
});

test('a completed streaming turn sends text, finish_reason, and DONE', async t => {
  const { post } = await start(t, async () => ({ thread: 'thread-1', text: 'Hello' }));
  const response = await post([user('Hi')], { stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const frames = (await response.text()).trimEnd().split('\n\n');
  assert.equal(frames.pop(), 'data: [DONE]');
  const chunks = frames.map(frame => JSON.parse(frame.slice('data: '.length)));
  assert.equal(chunks[0].choices[0].delta.content, 'Hello');
  assert.equal(chunks[1].choices[0].finish_reason, 'stop');
  assert.equal(chunks[2].usage.total_tokens, 3);
});

test('rejects wrong key, browser origin, and wrong route without execution', async t => {
  let calls = 0;
  const { post, url } = await start(t, async () => { calls++; });
  for (const options of [
    { headers: { 'x-opencode-codex-key': 'wrong' } },
    { headers: { 'x-opencode-codex-key': '' } },
    { headers: { origin: 'https://example.com' } },
    { url: `${url}/other` },
  ]) {
    assert.equal((await post([user('hi')], options)).status, 404);
  }
  assert.equal(calls, 0);
});

test('resumes the same thread with only the new turn and reseeds a new thread on divergent history', async t => {
  const calls = [];
  const { post } = await start(t, async args => {
    calls.push(args);
    return { thread: 'thread-1', text: calls.length === 1 ? 'First answer' : 'Second answer' };
  });
  assert.equal((await post([user('First')])).status, 200);
  const second = await post([user('First'), assistant('First answer'), user('Second')]);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).choices[0].message.content, 'Second answer');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].thread, 'thread-1');
  assert.equal(calls[1].prompt, 'Second');
  const divergent = await post([user('First'), assistant('changed'), user('Again')]);
  assert.equal(divergent.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].thread, undefined);
  assert.match(calls[2].prompt, /<transcript>[\s\S]*changed[\s\S]*<\/transcript>[\s\S]*Again$/);
});

test('switching to Codex mid-session seeds a thread from another agent history with tool calls', async t => {
  const calls = [];
  const { post } = await start(t, async args => { calls.push(args); return { thread: 't', text: 'ok' }; });
  const response = await post([
    { role: 'system', content: 'other agent prompt' },
    user('Inspect the file'),
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file body' },
    assistant('Done'),
    user('Continue'),
  ]);
  assert.equal(response.status, 200);
  assert.equal(calls[0].thread, undefined);
  assert.doesNotMatch(calls[0].prompt, /other agent prompt/);
  assert.match(calls[0].prompt, /\[tool call read\]/);
  assert.match(calls[0].prompt, /\[tool result\] file body/);
  assert.match(calls[0].prompt, /Continue$/);
});

test('compaction runs one ephemeral turn and the next primary turn reseeds', async t => {
  const calls = [];
  const { post } = await start(t, async args => { calls.push(args); return { thread: `t${calls.length}`, text: calls.length === 2 ? 'SUMMARY' : 'answer' }; });
  assert.equal((await post([user('First')])).status, 200);
  const compaction = await post([{ role: 'system', content: 'Summarize the conversation.' }, user('First'), assistant('answer')],
    { headers: { 'x-opencode-codex-kind': 'compaction' } });
  assert.equal(compaction.status, 200);
  assert.equal((await compaction.json()).choices[0].message.content, 'SUMMARY');
  assert.equal(calls[1].ephemeral, true);
  assert.equal(calls[1].thread, undefined);
  assert.match(calls[1].prompt, /Summarize the conversation\./);
  const next = await post([user('SUMMARY'), user('Next')]);
  assert.equal(next.status, 200);
  assert.equal(calls[2].thread, undefined);
  assert.match(calls[2].prompt, /SUMMARY[\s\S]*Next$/);
});

test('concurrent requests for one session do not execute twice', async t => {
  const pending = pendingExecution();
  const { bridge, post } = await start(t, pending.execute);
  const first = post([user('First')]);
  await pending.started;
  const second = await post([user('First')]);
  assert.equal(second.status, 400);
  assert.equal((await second.json()).error.type, 'codex_uncertain_turn');
  assert.equal(pending.calls, 1);
  bridge.interrupt('session-1');
  assert.equal((await first).status, 400);
});

test('an interrupted streaming turn returns an HTTP error even if execution resolves', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { bridge, post } = await start(t, ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ thread: 'late', text: 'Late reply' }), { once: true });
    entered();
  }));
  const response = post([user('Slow')], { stream: true, signal: AbortSignal.timeout(1500) });
  await started;
  bridge.interrupt('session-1');
  const result = await response;
  assert.equal(result.status, 400);
  assert.match((await result.json()).error.message, /interrupted/i);
});

test('interrupt propagates to the active execution only', async t => {
  const pending = pendingExecution();
  const { bridge, post } = await start(t, pending.execute);
  const response = post([user('First')]);
  const signal = await pending.started;
  bridge.interrupt('other-session');
  assert.equal(signal.aborted, false);
  bridge.interrupt('session-1');
  assert.equal(signal.aborted, true);
  assert.equal((await response).status, 400);
  assert.equal(pending.calls, 1);
});

test('closing the bridge aborts the active execution', async t => {
  const pending = pendingExecution();
  const { bridge, post } = await start(t, pending.execute);
  const response = post([user('First')]);
  // Attach immediately because close destroys the HTTP connection.
  const outcome = response.then(() => 'response', () => 'disconnected');
  const signal = await pending.started;
  bridge.close();
  assert.equal(signal.aborted, true);
  assert.equal(await outcome, 'disconnected');
  assert.equal(pending.calls, 1);
});

test('client disconnect aborts the active execution', async t => {
  const pending = pendingExecution();
  const { post } = await start(t, pending.execute);
  const controller = new AbortController();
  const response = post([user('First')], { signal: controller.signal });
  const outcome = response.then(() => 'response', () => 'disconnected');
  const signal = await pending.started;
  const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  controller.abort();
  assert.equal(await outcome, 'disconnected');
  await aborted;
  assert.equal(signal.aborted, true);
  assert.equal(pending.calls, 1);
});

test('after a failed resumed turn the next turn seeds a fresh thread', async t => {
  const calls = [];
  const { post } = await start(t, async args => {
    calls.push(args);
    if (calls.length === 2) throw new Error('execution failed');
    return { thread: 'thread-1', text: 'answer' };
  });
  assert.equal((await post([user('First')])).status, 200);
  assert.equal((await post([user('First'), assistant('answer'), user('Second')])).status, 400);
  assert.equal(calls[1].thread, 'thread-1');
  const retry = await post([user('First'), assistant('answer'), user('Second'), user('Third')]);
  assert.equal(retry.status, 200);
  assert.equal(calls[2].thread, undefined);
  assert.match(calls[2].prompt, /Do not repeat their actions[\s\S]*Second[\s\S]*New user message:\nThird$/);
});

test('a failed first turn reseeds on the next turn', async t => {
  const calls = [];
  const { post } = await start(t, async args => {
    calls.push(args);
    if (calls.length === 1) throw new Error('execution failed');
    return { thread: 'thread-2', text: 'answer' };
  });
  assert.equal((await post([user('First')])).status, 400);
  assert.equal((await post([user('First'), user('Again')])).status, 200);
  assert.equal(calls[1].thread, undefined);
  assert.match(calls[1].prompt, /<transcript>[\s\S]*First[\s\S]*Again$/);
});

test('after an interruption of a resumed turn the next turn seeds a fresh thread', async t => {
  let calls = [];
  let block = false;
  const { bridge, post } = await start(t, args => {
    calls.push(args);
    if (!block) return Promise.resolve({ thread: 'thread-1', text: 'answer' });
    return new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }));
  });
  assert.equal((await post([user('First')])).status, 200);
  block = true;
  const second = post([user('First'), assistant('answer'), user('Slow')]);
  while (calls.length < 2) await new Promise(r => setImmediate(r));
  bridge.interrupt('session-1');
  assert.equal((await second).status, 400);
  block = false;
  assert.equal((await post([user('First'), assistant('answer'), user('Slow'), user('Steer')])).status, 200);
  assert.equal(calls[2].thread, undefined);
  assert.match(calls[2].prompt, /Do not repeat their actions[\s\S]*Slow[\s\S]*New user message:\nSteer$/);
});

test('a disconnected turn with an observable effect is never executed again', async t => {
  let effects = 0;
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const { post } = await start(t, async ({ signal }) => {
    effects++;
    resolveStarted();
    if (effects > 1) return { thread: 'duplicate', text: 'Repeated effect' };
    await once(signal, 'abort');
    throw new Error('Disconnected after the effect');
  });
  const controller = new AbortController();
  const input = [user('Perform the effect once')];
  const first = assert.rejects(post(input, { signal: controller.signal }), { name: 'AbortError' });
  await started;
  controller.abort();
  await first;
  const replay = await post(input);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error.type, 'codex_uncertain_turn');
  assert.equal(effects, 1);
});

test('a completed request can be recovered without repeating execution', async t => {
  let effects = 0;
  const { post } = await start(t, async () => {
    effects++;
    return { thread: 'thread', text: 'Completed once' };
  });
  const input = [user('Perform the effect once')];
  assert.equal((await post(input)).status, 200);
  const replay = await post(input);
  assert.equal((await replay.json()).choices[0].message.content, 'Completed once');
  assert.equal(effects, 1);
});

test('subagent activity is scoped to the current turn and exposes only display fields', async t => {
  let resolveTurn;
  let startTurn;
  const started = new Promise(resolve => { startTurn = resolve; });
  const { bridge, post } = await start(t, ({ signal, onCollaboration }) => {
    onCollaboration({
      tool: 'spawn_agent',
      receiver_thread_ids: ['child-thread'],
      prompt: 'private prompt',
      agents_states: { 'child-thread': { status: 'running', message: 'private output' } },
    });
    startTurn(onCollaboration);
    return new Promise((resolve, reject) => {
      resolveTurn = resolve;
      signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
    });
  });
  const response = post([user('Delegate')]);
  const record = await started;
  assert.deepEqual(bridge.activity('another-session'), { running: false, waiting: false, agents: [] });
  assert.deepEqual(bridge.activity('session-1'), {
    running: true, waiting: false, lastAction: 'spawn_agent', agents: [{ number: 1, state: 'running', action: 'spawn_agent' }],
  });
  record({ tool: 'wait', status: 'in_progress', receiver_thread_ids: [] });
  assert.equal(bridge.activity('session-1').waiting, true);
  record({
    tool: 'wait',
    agents_states: { 'child-thread': { status: 'completed', message: 'private output' } },
  });
  resolveTurn({ thread: 'parent-thread', text: 'Done' });
  assert.equal((await response).status, 200);
  assert.deepEqual(bridge.activity('session-1'), {
    running: false, waiting: false, lastAction: 'wait', agents: [{ number: 1, state: 'completed', action: 'wait' }],
  });
});

test('keeps the last collaboration action when Codex omits agent identifiers', async t => {
  const { bridge, post } = await start(t, async ({ onCollaboration }) => {
    onCollaboration({ tool: 'wait', status: 'in_progress', receiver_thread_ids: [] });
    assert.deepEqual(bridge.activity('session-1'), {
      running: true, waiting: true, lastAction: 'wait', agents: [],
    });
    return { thread: 'parent-thread', text: 'Done' };
  });

  assert.equal((await post([user('Delegate')])).status, 200);
  assert.deepEqual(bridge.activity('session-1'), {
    running: false, waiting: false, lastAction: 'wait', agents: [],
  });
});

test('cancellation holds a delegated session until its executor settles', async t => {
  let resolveStarted;
  let resolveStopped;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  let calls = 0;
  const { bridge, post } = await start(t, async () => {
    if (++calls === 1) {
      resolveStarted();
      await stopped;
    }
    return { thread: 'thread', text: 'Done' };
  });
  const tools = [{ type: 'function', function: { name: 'subagent', parameters: { type: 'object' } } }];
  const first = post([user('Slow')], { tools });
  try {
    await started;
    bridge.interrupt('session-1');
    assert.equal((await post([user('Next')])).status, 400);
    assert.equal(calls, 1);
  } finally {
    resolveStopped();
    await first;
  }
  assert.equal((await post([user('Next')])).status, 200);
  assert.equal(calls, 2);
});

test('closing a tool continuation aborts the Codex turn that owns its call', { timeout: 3000 }, async t => {
  let calls = 0;
  let acceptResult;
  const accepted = new Promise(resolve => { acceptResult = resolve; });
  let confirmAbort;
  const aborted = new Promise(resolve => { confirmAbort = resolve; });
  let turnSignal;
  const { bridge, post } = await start(t, async ({ delegationURL, signal, onCollaboration }) => {
    if (++calls > 1) return { thread: 'next', text: 'Done' };
    assert.equal(onCollaboration, undefined);
    turnSignal = signal;
    const stopping = once(signal, 'abort');
    const response = await fetch(delegationURL, {
      method: 'POST',
      body: JSON.stringify({ method: 'tools/call', params: { name: 'subagent' } }),
    });
    acceptResult(await response.json());
    await stopping;
    confirmAbort();
    throw new Error('Cancelled');
  });
  const tools = [{ type: 'function', function: { name: 'subagent', parameters: { type: 'object' } } }];
  const input = [user('Delegate')];
  const response = await post(input, { tools });
  const message = (await response.json()).choices[0].message;
  assert.deepEqual(bridge.activity('session-1'), { running: false, waiting: false, agents: [] });
  const replay = await post(input, { tools });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error.type, 'codex_uncertain_turn');
  assert.equal(turnSignal.aborted, false);
  const controller = new AbortController();
  const continuation = assert.rejects(post([...input, message, {
    role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'Ready',
  }], { tools, signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await accepted).content[0].text, 'Ready');
  controller.abort();
  await continuation;
  await aborted;
  assert.equal(turnSignal.aborted, true);
  assert.equal(calls, 1);
});

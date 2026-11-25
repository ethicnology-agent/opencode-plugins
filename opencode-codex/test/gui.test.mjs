import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

// Loads the hand-written desktop bundle with minimal stand-ins for the modules the app provides.
function loadGui() {
  const require = createRequire(import.meta.url);
  const original = Module._load;
  const ComposerPill = Symbol('ComposerPill');
  let updateRoute;
  let cleanup;
  Module._load = function (request, ...rest) {
    if (request === '@opencode/plugin/gui') return {
      Plugin: { define: d => d },
      ComposerPill,
      createKeyed(source, run) {
        updateRoute = () => {
          cleanup?.();
          const value = source();
          if (value) run(value);
        };
      },
    };
    if (request === 'solid-js') {
      return {
        onCleanup(fn) { cleanup = fn; },
        createSignal(value) {
          return [() => value, next => { value = typeof next === 'function' ? next(value) : next; }];
        },
      };
    }
    return original.call(this, request, ...rest);
  };
  try {
    const path = require.resolve('../desktop/gui-experimental.cjs');
    delete require.cache[path];
    return { plugin: require(path).default, ComposerPill, updateRoute: () => updateRoute() };
  } finally {
    Module._load = original;
  }
}

test('composer pill reads the session server status over RPC and renders it', async () => {
  const { plugin, ComposerPill } = loadGui();
  const added = [];
  const controller = new AbortController();
  const calls = [];
  const status = {
    text: 'Claude 5h 10% · 7d 55% | Codex 7d 36% | CPU 61% · RAM 30G free · Disk 527G free',
    tone: 'warning',
    detail: {
      usage: { claude: { fiveHour: { remaining: 10 }, weekly: { remaining: 55 } }, codex: { weekly: { remaining: 36 } }, errors: {} },
      system: { cpu: { usedPercent: 61, cores: 10 }, ram: { availableGiB: 30, totalGiB: 48, sliceHeadroomGiB: 18 }, disk: { path: '/', freeGiB: 527, totalGiB: 1000 } },
    },
  };
  const session = {
    directory: '/repo',
    server: {
      id: 'ssh-azad-dev', name: 'azad-dev',
      client: { rpc: def => ({ read: async (input, options) => { calls.push({ def, input, options }); return status; } }) },
    },
  };
  plugin.setup({ add: (token, item) => added.push({ token, item }), signal: controller.signal });
  controller.abort();
  const pill = added.find(a => a.token === ComposerPill && a.item.id === 'status').item;
  assert.equal(pill.show({ session }).label, 'Status…');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].def.id, 'ethicnology.status');
  assert.deepEqual(calls[0].options.location, { directory: '/repo' });
  const view = pill.show({ session });
  assert.equal(view.label, 'CPU 61% · RAM 38% · DISK 47%');
  assert.equal(view.tone, 'warning');
  assert.ok(view.rows.some(r => r.label === 'Claude 5h: 10% left'));
  assert.ok(view.rows.some(r => r.label === 'Claude 7d: 55% left'));
  assert.ok(view.rows.some(r => r.label === 'Codex 7d: 36% left'));
  assert.ok(view.rows.some(r => r.label === 'Disk: 527 GiB free'));
});

test('composer pill shows unknown usage for incomplete host metrics without hiding quotas', async () => {
  const { plugin, ComposerPill } = loadGui();
  const added = [];
  const controller = new AbortController();
  const status = {
    detail: {
      usage: { codex: { weekly: { remaining: 90 } } },
      system: { cpu: { usedPercent: null }, ram: { availableGiB: 0, totalGiB: 0 }, disk: { freeGiB: 12 } },
    },
  };
  const session = { directory: '/repo', server: { id: 's', client: { rpc: () => ({ read: async () => status }) } } };
  plugin.setup({ add: (token, item) => added.push({ token, item }), signal: controller.signal });
  controller.abort();
  const pill = added.find(a => a.token === ComposerPill && a.item.id === 'status').item;
  pill.show({ session });
  await new Promise(r => setTimeout(r, 10));
  const view = pill.show({ session });
  assert.equal(view.label, 'CPU — · RAM — · DISK —');
  assert.ok(view.rows.some(r => r.label === 'Codex 7d: 90% left'));
});

test('composer pill shows host usage while the quota rows are loading', async () => {
  const { plugin } = loadGui();
  const pills = [];
  const controller = new AbortController();
  const status = { detail: { usage: { pending: true }, system: { cpu: { usedPercent: 45 } } } };
  const session = { directory: '/repo', server: { id: 's', client: { rpc: () => ({ read: async () => status }) } } };
  plugin.setup({ add: (_, item) => pills.push(item), signal: controller.signal });
  controller.abort();
  const pill = pills.find(item => item.id === 'status');
  pill.show({ session });
  await new Promise(r => setImmediate(r));
  const view = pill.show({ session });
  assert.equal(view.label, 'CPU 45% · RAM — · DISK —');
  assert.equal(view.rows.find(row => row.id === 'claude-5h').label, 'Claude 5h: Loading…');
  assert.equal(view.rows.find(row => row.id === 'codex-7d').label, 'Codex 7d: Loading…');
});

test('activity follows the routed SSH session and discards late replies', async t => {
  const { plugin, updateRoute } = loadGui();
  const controller = new AbortController();
  const pills = [];
  const calls = [];
  const server = {
    id: 'ssh',
    client: {
      rpc: definition => ({
        read: (input, options) => new Promise(resolve => calls.push({ definition, input, options, resolve })),
      }),
    },
  };
  const first = { id: 'first', key: 'ssh:first', visit: {}, server, directory: '/one' };
  const second = { id: 'second', key: 'ssh:second', visit: {}, server, directory: '/two' };
  let current = first;
  t.after(() => { current = undefined; updateRoute(); controller.abort(); });
  plugin.setup({ add: (_, item) => pills.push(item), sessions: { current: () => current }, signal: controller.signal });
  const pill = pills.find(item => item.id === 'codex-activity');
  updateRoute();
  assert.equal(pill.show({ session: first }), undefined);
  assert.equal(calls[0].definition.id, 'ethicnology.codex-activity');
  assert.deepEqual(calls[0].input, { sessionID: 'first' });
  assert.deepEqual(calls[0].options.location, { directory: '/one' });

  current = second;
  updateRoute();
  assert.ok(calls[0].options.signal.aborted);
  calls[1].resolve({ output: { running: true, agents: [{ number: 1, state: 'running', action: 'spawn_agent' }] } });
  calls[0].resolve({ running: false, agents: [{ number: 9, state: 'completed', action: 'wait' }] });
  await Promise.resolve();
  const view = pill.show({ session: second });
  assert.equal(view.label, 'Codex agents: 1 active');
  assert.deepEqual(view.rows, [{ id: '1', label: 'Agent 1 · Running', detail: 'Spawn requested' }]);
  assert.equal(pill.show({ session: first }), undefined);
});

test('composer pill reports an RPC failure without throwing', async () => {
  const { plugin, ComposerPill } = loadGui();
  const added = [];
  const controller = new AbortController();
  const session = { directory: '/repo', server: { id: 's', client: { rpc: () => ({ read: async () => { throw new Error('RPC is unavailable'); } }) } } };
  plugin.setup({ add: (token, item) => added.push({ token, item }), signal: controller.signal });
  controller.abort();
  const pill = added.find(a => a.token === ComposerPill && a.item.id === 'status').item;
  pill.show({ session });
  await new Promise(r => setTimeout(r, 10));
  const view = pill.show({ session });
  assert.equal(view.label, 'Status unavailable');
  assert.match(view.rows[0].detail, /unavailable/);
});

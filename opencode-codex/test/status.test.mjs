import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { createStatusReader } from '../status.mjs';

const system = {
  cpu: { usedPercent: 20 },
  ram: { availableGiB: 16, totalGiB: 32 },
  disk: { freeGiB: 50, totalGiB: 100 },
};
const claude = { fiveHour: { remaining: 40 } };
const codex = { weekly: { remaining: 60 } };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('first host reads return while a single quota refresh is pending', async () => {
  const quota = deferred();
  let reads = 0;
  const readStatus = createStatusReader({
    sample: async () => system,
    readClaude: () => { reads++; return quota.promise; },
    readCodex: () => codex,
  });
  const received = [];
  const requests = Array.from({ length: 2 }, () => readStatus().then(status => received.push(status)));
  try {
    await flush();
    assert.equal(reads, 1);
    assert.equal(received.length, 2);
    for (const status of received) {
      assert.equal(status.detail.system, system);
      assert.equal(status.detail.usage.pending, true);
      assert.equal(status.detail.usage.claude, null);
    }
  } finally {
    quota.resolve(claude);
    await Promise.all(requests);
  }
  await flush();
  const ready = await readStatus();
  assert.equal(ready.detail.usage.pending, false);
  assert.deepEqual(ready.detail.usage.claude, claude);
  assert.deepEqual(ready.detail.usage.codex, codex);
  assert.equal(reads, 1);
});

test('a failed quota fetch ends loading and retains previously reported values', async () => {
  let now = 1;
  let fetches = 0;
  const first = deferred();
  const later = deferred();
  const readStatus = createStatusReader({
    sample: async () => system,
    now: () => now,
    readClaude: () => [first.promise, claude, later.promise, claude][fetches++],
    readCodex: () => codex,
  });
  const start = readStatus();
  first.reject(new Error('First quota request failed'));
  await start;
  await flush();
  const failed = await readStatus();
  assert.equal(failed.detail.usage.pending, false);
  assert.equal(failed.detail.usage.claude, null);
  assert.match(failed.detail.usage.errors.claude, /First quota request failed/);

  now += 120_001;
  await readStatus();
  await flush();
  assert.deepEqual((await readStatus()).detail.usage.claude, claude);

  now += 120_001;
  assert.deepEqual((await readStatus()).detail.usage.claude, claude);
  later.reject(new Error('Later quota request failed'));
  await flush();
  const stale = await readStatus();
  assert.equal(stale.detail.system, system);
  assert.deepEqual(stale.detail.usage.claude, { ...claude, stale: true });

  now += 120_001;
  await readStatus();
  await flush();
  assert.deepEqual((await readStatus()).detail.usage.claude, claude);
  assert.equal(fetches, 4);
});

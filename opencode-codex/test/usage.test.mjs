import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexUsage } from '../usage.mjs';

test('Codex usage rejects if the app-server executable cannot start', { timeout: 2000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-codex-missing-'));
  t.after(() => rm(directory, { recursive: true }));
  await assert.rejects(readCodexUsage({ command: join(directory, 'missing') }), { code: 'ENOENT' });
});

test('Codex usage honors an abort before spawning an app server', { timeout: 2000 }, async () => {
  const reason = new Error('Stopped before launch');
  const signal = AbortSignal.abort(reason);
  await assert.rejects(readCodexUsage({ command: '/dev/null', signal }), error => error === reason);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openUsageStore, normalizeUsageRetention, validateUsageRetention } from '../src/usage.js';

test('configuração de retenção aceita horas ou vazio e rejeita valores fora da faixa', () => {
  assert.deepEqual(normalizeUsageRetention(undefined), { retentionHours: 24 });
  assert.deepEqual(normalizeUsageRetention(null), { retentionHours: null });
  assert.deepEqual(normalizeUsageRetention({ retentionHours: '168' }), { retentionHours: 168 });
  assert.equal(validateUsageRetention({ retentionHours: 24 }), null);
  assert.equal(validateUsageRetention({ retentionHours: null }), null);
  assert.match(validateUsageRetention({ retentionHours: 0 }), /entre 1 e 8760/);
  assert.match(validateUsageRetention({ retentionHours: 8761 }), /entre 1 e 8760/);
  assert.match(validateUsageRetention(normalizeUsageRetention({ retentionHours: 'abc' })), /entre 1 e 8760/);
});

test('prune local remove somente registros mais antigos que a retenção', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-retention-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'data'), { recursive: true });
  const store = await openUsageStore(dir);
  const record = (id, startedAt) => ({ id, requestId: id, attempt: 1, startedAt, status: 'completed', clientKeyId: 'k1', usage: {} });
  await store.write(record('antigo', '2026-11-23T10:00:00.000Z'));
  await store.write(record('limiar', '2026-11-23T12:00:00.000Z'));
  await store.write(record('recente', '2026-11-24T11:00:00.000Z'));

  assert.equal(await store.prune(24, '2026-11-24T12:00:00.000Z'), 1);
  assert.deepEqual((await store.list()).map(item => item.id), ['recente', 'limiar']);
  const lines = (await readFile(path.join(dir, 'data', 'usage.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(await store.prune(null, '2026-11-24T12:00:00.000Z'), 0);
  assert.equal((await store.list()).length, 2);
});

test('prune local não cria arquivo de uso quando não há histórico', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-retention-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openUsageStore(dir);
  assert.equal(await store.prune(24, '2026-11-24T12:00:00.000Z'), 0);
  await assert.rejects(stat(path.join(dir, 'data', 'usage.jsonl')), { code: 'ENOENT' });
});

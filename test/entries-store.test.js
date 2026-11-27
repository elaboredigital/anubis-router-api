import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openEntries } from '../src/store.js';

test('lançamentos ficam um por linha e a última versão de cada item vence', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-entries-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entries = await openEntries(dir, '');
  assert.deepEqual(await entries.list('ledger'), []);
  await entries.upsert('ledger', { id: 'a', sale: '1' });
  await entries.upsertMany('ledger', [{ id: 'b', sale: '2' }, { id: 'c', sale: '3' }]);
  await entries.upsert('ledger', { id: 'a', sale: '1.5' });
  await entries.upsert('topups', { id: 'a', amount: '10' });
  assert.deepEqual((await entries.list('ledger')).map(item => [item.id, item.sale]), [['a', '1.5'], ['b', '2'], ['c', '3']]);
  assert.deepEqual(await entries.list('topups'), [{ id: 'a', amount: '10' }]);
});

test('cota do plano lê todos os registros da chave no período, não só os 10 mil mais recentes do sistema', async t => {
  const { openUsageStore } = await import('../src/usage.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-usage-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const usage = await openUsageStore(dir, '');
  await usage.write({ id: 'old', clientKeyId: 'k1', startedAt: '2026-10-31T23:59:00Z', status: 'completed' });
  await usage.write({ id: 'a', clientKeyId: 'k1', startedAt: '2026-11-02T10:00:00Z', status: 'completed' });
  await usage.write({ id: 'b', clientKeyId: 'k2', startedAt: '2026-11-03T10:00:00Z', status: 'completed' });
  await usage.write({ id: 'a', clientKeyId: 'k1', startedAt: '2026-11-02T10:00:00Z', status: 'upstream_error' });
  const rows = await usage.listForKeys(['k1'], '2026-11-01T00:00:00Z');
  assert.deepEqual(rows.map(r => [r.id, r.status]), [['a', 'upstream_error']]);
});

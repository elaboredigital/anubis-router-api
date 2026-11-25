import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectSystemReport, createTrafficCounters } from '../src/system-metrics.js';

test('contadores de tráfego somam bytes sem guardar conteúdo', () => {
  const traffic = createTrafficCounters();
  traffic.noteRequestBytes(120);
  traffic.noteUpstreamRequestBytes(80);
  traffic.noteResponseBytes(40);
  traffic.noteStreamedResponseBytes(200);
  traffic.noteStreamedResponseBytes(-5);
  const snapshot = traffic.snapshot();
  assert.equal(snapshot.requestBytesTotal, 120);
  assert.equal(snapshot.upstreamRequestBytesTotal, 80);
  assert.equal(snapshot.responseBytesTotal, 240);
  assert.equal(snapshot.requestsWithBodyCount, 1);
  assert.equal(snapshot.streamedResponsesCount, 2);
  assert.equal(snapshot.jsonResponsesCount, 1);
  assert.equal(snapshot.httpMessagesTotal, 4);
});

test('relatório do sistema expõe agregados locais e nunca o conteúdo privado', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-system-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'data'), { recursive: true });
  await writeFile(path.join(dir, 'data', 'usage.jsonl'), JSON.stringify({ prompt: 'prompt-secreto', secret: 'chave-secreta' }) + '\n');
  const traffic = createTrafficCounters();
  traffic.noteRequestBytes(1024);
  const report = await collectSystemReport({
    root: dir, traffic, store: { kind: 'arquivos' }, usageStore: { size: async () => null },
    retention: { retentionHours: 24 },
    counts: { routesEnabled: 2, connectionsActive: 1, keysActive: 3, plansCount: 1 },
    now: '2026-11-24T12:00:00.000Z',
  });
  assert.equal(report.generatedAt, '2026-11-24T12:00:00.000Z');
  assert.equal(report.retention.retentionHours, 24);
  assert.equal(report.traffic.requestBytesTotal, 1024);
  assert.equal(report.gateway.routesEnabled, 2);
  assert.equal(report.storage.mode, 'arquivos');
  assert.equal(report.storage.database.tables.length, 0);
  assert.equal(report.storage.dataFiles.find(file => file.name === 'usage.jsonl').bytes > 0, true);
  assert.equal(report.storage.dataFilesTotalBytes > 0, true);
  assert.ok(report.process.memory.rssBytes > 0);
  assert.ok(report.host.cpuCount >= 1);
  const text = JSON.stringify(report);
  for (const secret of ['prompt-secreto', 'chave-secreta', dir]) assert.equal(text.includes(secret), false);
});

test('relatório do sistema inclui o tamanho das tabelas no Postgres', async () => {
  const traffic = createTrafficCounters();
  const report = await collectSystemReport({
    root: path.join(os.tmpdir(), 'anubis-system-postgres'), traffic,
    store: { kind: 'postgres', size: async () => 40960 },
    usageStore: { size: async () => 81920 },
    retention: { retentionHours: null },
  });
  assert.equal(report.storage.mode, 'postgres');
  assert.deepEqual(report.storage.database.tables, [
    { name: 'anubis_store', totalBytes: 40960 },
    { name: 'anubis_usage', totalBytes: 81920 },
  ]);
  assert.equal(report.retention.retentionHours, null);
});

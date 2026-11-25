import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('API de conciliação filtra por período, anota sem custo e preserva auditoria', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-reconcile-test-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../public', path.join(dir, 'public'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const baseRecord = {
    provider: 'xkiro', connectionId: 'conn-1', clientKeyId: 'key-1', planId: null,
    publicModel: 'anubis/teste', upstreamModel: 'remote/model', endpoint: '/v1/chat/completions',
    costSnapshot: { request: '0.02', currency: 'USD' }, saleSnapshot: { multiplier: '5', versionIds: [] },
  };
  const records = [
    { ...baseRecord, id: 'attempt-pending', requestId: 'req-pending', attempt: 1, destinationId: 'dest-1', status: 'pending', startedAt: '2026-11-24T10:00:00.000Z', usage: {} },
    { ...baseRecord, id: 'attempt-unknown', requestId: 'req-unknown', attempt: 2, destinationId: 'dest-2', status: 'upstream_unknown', startedAt: '2026-11-24T10:05:00.000Z', finishedAt: '2026-11-24T10:05:03.000Z', usage: { inputTokens: 9 }, prompt: 'prompto privado', secret: 'chave-nunca-deve-sair' },
    { ...baseRecord, id: 'attempt-done', requestId: 'req-done', attempt: 1, destinationId: 'dest-1', status: 'completed', startedAt: '2026-11-24T10:06:00.000Z', finishedAt: '2026-11-24T10:06:01.000Z', usage: { inputTokens: 4 } },
    { ...baseRecord, id: 'attempt-error', requestId: 'req-error', attempt: 1, destinationId: 'dest-1', status: 'upstream_error', httpStatus: 500, startedAt: '2026-11-24T10:07:00.000Z', finishedAt: '2026-11-24T10:07:01.000Z', usage: {} },
    { ...baseRecord, id: 'attempt-old', requestId: 'req-old', attempt: 1, destinationId: 'dest-1', status: 'pending', startedAt: '2026-11-23T10:00:00.000Z', usage: {} },
  ];
  await mkdir(path.join(dir, 'data'), { recursive: true });
  await writeFile(path.join(dir, 'data', 'usage.jsonl'), records.map(item => JSON.stringify(item)).join('\n') + '\n');
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`servidor encerrou com ${code}`))); });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
  const request = async (url, options = {}) => {
    const response = await fetch(`${base}${url}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  };
  const period = 'from=2026-11-24T00:00:00.000Z&to=2026-11-25T00:00:00.000Z';

  let report = await request(`/admin/usage/pending?${period}`);
  assert.equal(report.status, 200);
  assert.deepEqual(report.body.items.map(item => item.id), ['attempt-unknown', 'attempt-pending']);
  assert.equal(report.body.summary.total, 2);
  assert.equal(report.body.summary.requests, 2);
  assert.equal(report.body.summary.byReason.sem_desfecho, 1);
  assert.equal(report.body.summary.byReason.falha_transporte, 1);
  assert.equal(report.text.includes('prompto privado'), false);
  assert.equal(report.text.includes('chave-nunca-deve-sair'), false);

  const invalid = await request('/admin/usage/pending?from=2026-11-25T00:00:00.000Z&to=2026-11-24T00:00:00.000Z');
  assert.equal(invalid.status, 400);
  const usage = await request(`/admin/usage?${period}`);
  assert.equal(usage.status, 200);
  assert.equal(usage.body.recordCount, 4);
  assert.equal(usage.body.period.from, '2026-11-24T00:00:00.000Z');

  const saved = await request('/admin/usage/reconcile', { method: 'POST', body: JSON.stringify({ recordId: 'attempt-unknown', outcome: 'no_cost', note: 'fornecedor confirmou ausência de cobrança' }) });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.duplicate, false);
  assert.equal(saved.body.annotation.recordId, 'attempt-unknown');
  assert.equal(saved.body.audit.at(-1).after.outcome, 'no_cost');
  const duplicate = await request('/admin/usage/reconcile', { method: 'POST', body: JSON.stringify({ recordId: 'attempt-unknown', outcome: 'no_cost' }) });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);

  report = await request(`/admin/usage/pending?${period}`);
  assert.deepEqual(report.body.items.map(item => item.id), ['attempt-pending']);
  assert.equal(report.body.summary.resolved, 1);
  const all = await request(`/admin/usage/pending?${period}&includeResolved=true`);
  assert.deepEqual(all.body.items.map(item => item.id), ['attempt-unknown', 'attempt-pending']);
  assert.equal(all.body.items[0].reconciliation.outcome, 'no_cost');
  assert.equal(all.body.items[0].status, 'upstream_unknown');
  assert.deepEqual(all.body.items[0].usage, { inputTokens: 9 });

  const rejected = await request('/admin/usage/reconcile', { method: 'POST', body: JSON.stringify({ recordId: 'attempt-done', outcome: 'no_cost' }) });
  assert.equal(rejected.status, 400);
  const auditFile = JSON.parse(await readFile(path.join(dir, 'data', 'usage-reconciliation-audit.json'), 'utf8'));
  assert.equal(auditFile.length, 1);
  assert.equal(JSON.stringify(auditFile).includes('chave-nunca-deve-sair'), false);
  const updated = (await readFile(path.join(dir, 'data', 'usage.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const annotated = updated.filter(item => item.id === 'attempt-unknown').at(-1);
  assert.equal(annotated.status, 'upstream_unknown');
  assert.equal(annotated.reconciliation.outcome, 'no_cost');
  assert.equal(annotated.costSnapshot.request, '0.02');
});

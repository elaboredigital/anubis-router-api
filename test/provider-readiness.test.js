import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectors } from '../src/connectors.js';
import { buildReadiness, normalizeReadinessUpdate, validateReadinessUpdate, commercialBlock, CONNECTION_BLOCKED, DEFAULT_READINESS_POLICY } from '../src/provider-readiness.js';

const profile = id => connectors.find(item => item.id === id);

test('homologação começa como planejada e não autoriza revenda nem venda', () => {
  const item = buildReadiness(profile('xkiro'));
  assert.equal(item.status, 'planejado');
  assert.equal(item.resaleConfirmed, false);
  assert.equal(item.commercialReady, false);
  assert.equal(item.connectable, true);
  assert.equal(item.billingUnits.includes('token'), true);
  assert.match(item.restriction, /permissão escrita/);
  assert.equal(commercialBlock('xkiro', [item], DEFAULT_READINESS_POLICY), null);
  assert.match(commercialBlock('xkiro', [item], { enforceResale: true }), /sem homologação documentada/);
});

test('fornecedores restritos permanecem bloqueados mesmo após tentativa de homologação', () => {
  for (const id of Object.keys(CONNECTION_BLOCKED)) {
    const item = buildReadiness(profile(id));
    assert.equal(item.connectable, false, id);
    const next = normalizeReadinessUpdate({ status: 'homologado', resaleConfirmed: true, resaleEvidence: 'contrato', reviewedAt: '2026-11-24' }, item);
    assert.match(validateReadinessUpdate(next, profile(id), item), /bloqueado por restrição contratual/);
  }
});

test('revenda confirmada exige evidência e homologação exige revisão datada', () => {
  const current = buildReadiness(profile('maxrouter'));
  const withoutEvidence = normalizeReadinessUpdate({ resaleConfirmed: true }, current);
  assert.match(validateReadinessUpdate(withoutEvidence, profile('maxrouter'), current), /referência escrita/);
  const incomplete = normalizeReadinessUpdate({ status: 'homologado', resaleConfirmed: true, resaleEvidence: 'contrato-123' }, current);
  assert.match(validateReadinessUpdate(incomplete, profile('maxrouter'), current), /data de revisão/);
  const readyUpdate = normalizeReadinessUpdate({ status: 'homologado', resaleConfirmed: true, resaleEvidence: 'contrato-123', reviewedAt: '2026-11-24' }, current);
  assert.equal(validateReadinessUpdate(readyUpdate, profile('maxrouter'), current), null);
  const ready = buildReadiness(profile('maxrouter'), [readyUpdate]);
  assert.equal(ready.commercialReady, true);
  assert.equal(commercialBlock('maxrouter', [ready], { enforceResale: true }), null);
});

test('admin persiste homologação e aplica gate opcional sem expor segredos', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-readiness-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../admin', path.join(dir, 'public'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const adminHeaders = { authorization: 'Bearer admin-key-1234567890123', 'content-type': 'application/json' };
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), ANUBIS_ADMIN_KEY: 'admin-key-1234567890123', ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', code => reject(new Error(`servidor encerrou com ${code}`)));
  });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/admin/provider-readiness`)).status, 401);
  let report = await (await fetch(`${base}/admin/provider-readiness`, { headers: adminHeaders })).json();
  assert.equal(report.providers.length, connectors.length);
  assert.equal(report.providers.find(item => item.providerId === 'duck').connectable, false);
  assert.equal(report.policy.enforceResale, false);

  const post = (payload, headers = adminHeaders) => fetch(`${base}/admin/provider-readiness`, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal((await post({ providerId: 'duck', status: 'homologado', resaleConfirmed: true, resaleEvidence: 'x', reviewedAt: '2026-11-24' })).status, 400);
  assert.equal((await post({ providerId: 'xkiro', resaleConfirmed: true })).status, 400);
  const saved = await post({ providerId: 'xkiro', status: 'em_homologacao', resaleConfirmed: true, resaleEvidence: 'autorizacao-interna-01', reviewedAt: '2026-11-24', note: 'Revisão local' });
  assert.equal(saved.status, 200);
  report = await saved.json();
  const xkiro = report.providers.find(item => item.providerId === 'xkiro');
  assert.equal(xkiro.resaleConfirmed, true);
  assert.equal(xkiro.commercialReady, false);
  assert.equal(report.audit[0].providerId, 'xkiro');
  assert.equal(JSON.stringify(report).includes('autorizacao-interna-01'), true);
  assert.equal(JSON.stringify(report).includes('apiKey'), false);

  assert.equal((await post({ enforceResale: true })).status, 200);
  const blockedPrice = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'model', provider: 'xkiro', model: 'remote/model', multiplier: '1.5' }) });
  assert.equal(blockedPrice.status, 403);
  assert.match((await blockedPrice.json()).error, /sem homologação documentada/);
  assert.equal((await post({ enforceResale: false })).status, 200);
  const allowedPrice = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'model', provider: 'xkiro', model: 'remote/model', multiplier: '1.5' }) });
  assert.equal(allowedPrice.status, 200);

  const page = await (await fetch(`${base}/providers`)).text();
  for (const id of ['readiness-provider', 'readiness-status', 'readiness-enforce', 'readiness-list']) assert.match(page, new RegExp(`id="${id}"`));
});

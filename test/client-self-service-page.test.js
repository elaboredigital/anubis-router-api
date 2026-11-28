import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('área do cliente cria e administra chaves derivadas sem acesso administrativo', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-client-area-'));
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
  const clientHeaders = key => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
  const request = (route, options = {}) => fetch(`${base}${route}`, options);
  const jsonRequest = (route, key, method = 'GET', data = null) => request(route, {
    method,
    headers: clientHeaders(key),
    ...(data === null ? {} : { body: JSON.stringify(data) }),
  });

  assert.equal((await request('/me/summary')).status, 401);
  assert.equal((await request('/minha-conta')).status, 200);
  const page = await (await request('/minha-conta')).text();
  assert.equal(page, await (await request('/')).text());
  assert.match(page, /data-nav="client-area"/);
  assert.match(page, /id="dashboard"/);
  for (const id of ['client-area-key', 'client-area-remember', 'client-area-enter', 'client-area-content', 'client-area-plans', 'client-area-key-form', 'client-area-key-list', 'client-area-stats-from', 'client-area-stats-to', 'client-area-stats-series']) {
    assert.match(page, new RegExp(`id="${id}"`), id);
  }
  const script = await (await request('/account.js')).text();
  assert.match(script, /\/me\/summary/);
  assert.equal(script.includes('/admin/'), false);
  assert.equal(script.includes('localStorage'), false);

  const created = await request('/admin/keys', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Titular', planId: 'free' }) });
  assert.equal(created.status, 201);
  const { key: rootKey, id: rootId } = await created.json();

  let report = await (await jsonRequest('/me/summary', rootKey)).json();
  assert.equal(report.account.isRoot, true);
  assert.equal(report.account.id, rootId);
  assert.equal(report.keys.length, 1);
  assert.equal(report.availablePlans.some(plan => plan.id === 'free'), true);
  assert.equal(report.availablePlans.some(plan => plan.id === 'pro' || plan.id === 'premium'), false);
  assert.equal(JSON.stringify(report).includes(rootKey), false);
  assert.equal(JSON.stringify(report).includes('hash'), false);

  const derived = await jsonRequest('/me/keys', rootKey, 'POST', { name: 'Ferramenta', planId: 'free' });
  assert.equal(derived.status, 201);
  const derivedResult = await derived.json();
  assert.match(derivedResult.key, /^anubis_/);
  report = await (await jsonRequest('/me/summary', derivedResult.key)).json();
  assert.equal(report.account.isRoot, false);
  assert.deepEqual(report.keys.map(item => item.role), ['principal', 'derivada']);
  assert.equal(report.account.label.startsWith('anubis_'), true);

  const other = await request('/admin/keys', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Outro titular', planId: 'free' }) });
  const otherKey = (await other.json()).key;
  const otherReport = await (await jsonRequest('/me/summary', otherKey)).json();
  assert.equal(otherReport.keys.length, 1);
  assert.equal((await jsonRequest('/me/keys/plan', otherKey, 'POST', { id: derivedResult.id, planId: 'free' })).status, 403);
  assert.equal((await jsonRequest('/me/keys/revoke', otherKey, 'POST', { id: derivedResult.id })).status, 400);
  assert.equal((await jsonRequest('/me/keys/revoke', rootKey, 'POST', { id: rootId })).status, 400);

  const plan = await request('/admin/plans', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Cliente local', kind: 'free', monthlyRequests: 50, monthlyTokens: 1000, models: [], active: true, selfService: true }) });
  assert.equal(plan.status, 201);
  const planId = (await plan.json()).plan.id;
  // O cliente não troca o plano: ele vem da assinatura mensal ou dos créditos da conta.
  assert.equal((await jsonRequest('/me/keys/plan', rootKey, 'POST', { id: derivedResult.id, planId })).status, 403);
  const keysNow = (await (await jsonRequest('/me/summary', rootKey)).json()).keys;
  assert.equal(keysNow.find(item => item.id === derivedResult.id).planId, keysNow.find(item => item.id === rootId).planId, 'chave nova herda o plano da principal');

  const stats = await jsonRequest('/me/stats?from=2026-11-01T00:00:00.000Z&to=2026-11-25T00:00:00.000Z', rootKey);
  assert.equal(stats.status, 200);
  const statsReport = await stats.json();
  assert.deepEqual(statsReport.period, { from: '2026-11-01T00:00:00.000Z', to: '2026-11-25T00:00:00.000Z', clamped: false });
  assert.equal(statsReport.account.label.startsWith('anubis_'), true);
  const statsText = JSON.stringify(statsReport);
  for (const needle of [rootKey, 'hash', 'secret', 'prompt', 'response']) assert.equal(statsText.includes(needle), false, needle);
  assert.equal((await jsonRequest('/me/stats?from=01/11/2026', rootKey)).status, 400);

  assert.equal((await jsonRequest('/me/keys/revoke', rootKey, 'POST', { id: derivedResult.id })).status, 200);
  assert.equal((await jsonRequest('/me/summary', derivedResult.key)).status, 401);
  assert.equal((await request('/admin/status', { headers: clientHeaders(rootKey) })).status, 401);
});

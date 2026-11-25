import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('política de roteamento persiste, aplica pesos, limita tentativas e audita mudanças', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-routing-test-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../admin', path.join(dir, 'public'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const attempts = [];
  const keys = new Set(['upstream-A-1234567890', 'upstream-B-1234567890']);
  const mock = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      if (!keys.has(req.headers.authorization?.replace('Bearer ', ''))) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [
        { id: 'remote/model', display_name: 'Modelo', modality: 'chat', billing_type: 'request', pricing: { request: '0.02', currency: 'USD' } },
        { id: 'remote/fail', display_name: 'Falha', modality: 'chat', billing_type: 'request', pricing: { request: '0.02', currency: 'USD' } },
        { id: 'remote/auth', display_name: 'Auth', modality: 'chat', billing_type: 'request', pricing: { request: '0.02', currency: 'USD' } },
      ] }));
    }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    attempts.push({ authorization: req.headers.authorization, model: body.model });
    if (body.model === 'remote/fail') { res.writeHead(429); return res.end('limit'); }
    if (body.model === 'remote/auth') { res.writeHead(401); return res.end('unauthorized'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), TEST_UPSTREAM_URL: `http://127.0.0.1:${mock.address().port}`, ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`servidor encerrou com ${code}`))); });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); await new Promise(resolve => mock.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const adminHeaders = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
  const get = async url => (await fetch(`${base}${url}`, { headers: adminHeaders })).json();
  const post = async (url, data) => {
    const response = await fetch(`${base}${url}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };

  let report = await get('/admin/routes');
  assert.equal(report.policy.strategy, 'round_robin');
  assert.equal(report.policy.maxAttempts, null);
  assert.equal(report.policy.failoverOnError, true);
  assert.deepEqual(report.policy.retryStatuses, [429, 500, 502, 503, 504]);
  assert.deepEqual(report.audit, []);
  assert.equal((await post('/admin/routing-policy', { strategy: 'aleatoria' })).status, 400);
  const weightedPolicy = { strategy: 'weighted', maxAttempts: 4, retryStatuses: '429, 500', timeoutMs: '1500', cooldownMs: '0' };
  assert.equal((await post('/admin/routing-policy', weightedPolicy)).status, 200);
  report = await get('/admin/routes');
  assert.deepEqual(report.policy, { strategy: 'weighted', maxAttempts: 4, retryStatuses: [429, 500], timeoutMs: 1500, cooldownMs: 0, failoverOnError: true });
  assert.equal(report.audit[0].action, 'policy');

  const connectionA = (await post('/admin/connections', { provider: 'xkiro', name: 'A', key: 'upstream-A-1234567890' })).body.connection;
  const connectionB = (await post('/admin/connections', { provider: 'xkiro', name: 'B', key: 'upstream-B-1234567890' })).body.connection;
  for (const connection of [connectionA, connectionB]) {
    for (const id of ['remote/model', 'remote/fail']) assert.equal((await post(`/admin/connections/${connection.id}/models`, { id, enabled: true })).status, 200);
  }
  const apiKey = (await post('/admin/keys', { name: 'Cliente' })).body.key;
  const call = async (model, extra = {}) => {
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [], ...extra }) });
    await response.text();
    return response.status;
  };
  const routes = async (id, upstreamModel, connectionId, priority, weight = 1) => {
    const result = await post('/admin/routes', { id, provider: 'xkiro', connectionId, upstreamModel, enabled: true, priority, weight });
    assert.equal(result.status, 200);
    return result.body.route;
  };
  await routes('anubis/pesos', 'remote/model', connectionA.id, 100, 4);
  await routes('anubis/pesos', 'remote/model', connectionB.id, 100, 1);
  attempts.length = 0;
  for (let i = 0; i < 40; i++) assert.equal(await call('anubis/pesos', { content: `consulta-${i}` }), 200);
  const byConnection = new Map();
  for (const item of attempts) byConnection.set(item.authorization, (byConnection.get(item.authorization) || 0) + 1);
  assert.equal(byConnection.size, 2);
  assert.ok(byConnection.get(`Bearer upstream-A-1234567890`) > byConnection.get(`Bearer upstream-B-1234567890`));

  assert.equal((await post('/admin/routing-policy', { strategy: 'priority', maxAttempts: 1, retryStatuses: [429], timeoutMs: '', cooldownMs: 0 })).status, 200);
  await routes('anubis/limite', 'remote/fail', connectionA.id, 1);
  await routes('anubis/limite', 'remote/model', connectionB.id, 2);
  attempts.length = 0;
  assert.equal(await call('anubis/limite'), 429);
  assert.deepEqual(attempts.map(item => item.model), ['remote/fail']);

  assert.equal((await post('/admin/routing-policy', { strategy: 'priority', maxAttempts: null, retryStatuses: [429], timeoutMs: '', cooldownMs: 60000 })).status, 200);
  attempts.length = 0;
  assert.equal(await call('anubis/limite'), 200);
  assert.deepEqual(attempts.map(item => item.model), ['remote/fail', 'remote/model']);
  report = await get('/admin/routes');
  const cooled = report.routes.find(route => route.id === 'anubis/limite' && route.upstreamModel === 'remote/fail');
  assert.ok(Date.parse(cooled.cooldownUntil) > Date.now());
  assert.equal(report.audit.some(event => event.action === 'cooldown'), true);
  attempts.length = 0;
  assert.equal(await call('anubis/limite'), 200);
  assert.deepEqual(attempts.map(item => item.model), ['remote/model']);

  const rotateRoutes = [];
  rotateRoutes.push(await routes('anubis/rotacao', 'remote/model', connectionA.id, 1));
  rotateRoutes.push(await routes('anubis/rotacao', 'remote/model', connectionB.id, 2));
  rotateRoutes.push(await routes('anubis/rotacao', 'remote/fail', connectionB.id, 3));
  const rotated = await post('/admin/routes/rotate', { id: 'anubis/rotacao' });
  assert.equal(rotated.status, 200);
  assert.deepEqual(rotated.body.routes.map(route => route.destinationId), [rotateRoutes[1].destinationId, rotateRoutes[2].destinationId, rotateRoutes[0].destinationId]);
  assert.deepEqual(rotated.body.routes.map(route => route.priority), [1, 2, 3]);
  assert.equal(rotated.body.audit.at(-1).action, 'rotate');
  const removed = await fetch(`${base}/admin/routes/${rotateRoutes[1].destinationId}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(removed.status, 200);
  report = await get('/admin/routes');
  assert.equal(report.routes.filter(route => route.id === 'anubis/rotacao').length, 2);
  assert.equal(report.audit.at(-1).action, 'remove');
  const auditText = JSON.stringify(report);
  assert.equal(auditText.includes('upstream-A-1234567890'), false);
  assert.equal(auditText.includes('upstream-B-1234567890'), false);

  for (const connection of [connectionA, connectionB]) {
    assert.equal((await post(`/admin/connections/${connection.id}/models`, { id: 'remote/auth', enabled: true })).status, 200);
  }
  assert.equal((await post('/admin/routing-policy', { strategy: 'priority', maxAttempts: '', retryStatuses: [], failoverOnError: true, timeoutMs: '', cooldownMs: 0 })).status, 200);
  await routes('anubis/failover401', 'remote/auth', connectionA.id, 1);
  await routes('anubis/failover401', 'remote/model', connectionB.id, 2);
  attempts.length = 0;
  assert.equal(await call('anubis/failover401'), 200);
  assert.deepEqual(attempts.map(item => item.model), ['remote/auth', 'remote/model']);
  const captured = await get('/admin/gateway-failures');
  assert.ok(captured.recent.some(row => row.httpStatus === 401 && row.reason === 'resposta_http' && row.retryable === true));
  assert.equal((await post('/admin/routing-policy', { strategy: 'priority', maxAttempts: '', retryStatuses: [], failoverOnError: false, timeoutMs: '', cooldownMs: 0 })).status, 200);
  attempts.length = 0;
  assert.equal(await call('anubis/failover401'), 401);
  assert.deepEqual(attempts.map(item => item.model), ['remote/auth']);

  const routesPage = await (await fetch(`${base}/routes`)).text();
  for (const id of ['route-relationships', 'routing-strategy', 'routing-failover', 'routing-max-attempts']) {
    assert.match(routesPage, new RegExp(`id="${id}"`), id);
  }
  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /function renderRouteRelationships/);
  assert.match(script, /routing-failover/);
});

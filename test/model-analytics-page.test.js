import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('endpoint /admin/model-analytics exige chave administrativa e período ISO UTC', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-model-analytics-page-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../public', path.join(dir, 'public'), { recursive: true });
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
  const query = '?from=2026-11-22T00:00:00.000Z&to=2026-11-25T00:00:00.000Z';

  assert.equal((await fetch(`${base}/admin/model-analytics${query}`)).status, 401);
  assert.equal((await fetch(`${base}/admin/model-analytics?from=22/11/2026`, { headers: adminHeaders })).status, 400);
  assert.equal((await fetch(`${base}/admin/model-analytics${query}&model=modelo%20invalido`, { headers: adminHeaders })).status, 400);
  assert.equal((await fetch(`${base}/admin/model-analytics${query}&model=anubis%2Finexistente`, { headers: adminHeaders })).status, 404);

  const response = await fetch(`${base}/admin/model-analytics${query}`, { headers: adminHeaders });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.deepEqual(report.period, { from: '2026-11-22T00:00:00.000Z', to: '2026-11-25T00:00:00.000Z', clamped: false });
  assert.deepEqual(report.admin, { configured: true, clientSessions: 0, keys: 0, activeKeys: 0 });
  assert.deepEqual(report.models, []);
  assert.deepEqual(report.totals.spend, []);
  assert.equal(report.scope, 'last_10000_requests');
  const text = JSON.stringify(report);
  for (const needle of ['hash', 'secret', 'prompt', 'response', 'apiKey']) assert.equal(text.includes(needle), false, needle);

  const created = await fetch(`${base}/admin/keys`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Cliente teste', planId: null }) });
  assert.equal(created.status, 201);
  const keyResult = await created.json();
  const after = await (await fetch(`${base}/admin/model-analytics${query}`, { headers: adminHeaders })).json();
  assert.equal(after.admin.keys, 1);
  assert.equal(after.admin.activeKeys, 1);
  const afterText = JSON.stringify(after);
  assert.equal(afterText.includes(keyResult.key), false);
  assert.equal(afterText.includes(keyResult.hash || 'hash-secreto'), false);

  const html = await (await fetch(`${base}/models`)).text();
  const start = html.indexOf('data-page="models"');
  assert.notEqual(start, -1, 'seção models');
  const end = html.indexOf('data-page="', start + 1);
  const modelsPage = html.slice(start, end === -1 ? html.length : end);
  for (const id of ['model-analytics-filter', 'model-analytics-from', 'model-analytics-to', 'model-analytics-clear', 'model-analytics-refresh', 'model-analytics-message', 'model-analytics-period-summary', 'model-analytics-spend', 'model-analytics-profit', 'model-analytics-margin', 'model-analytics-models-count', 'model-analytics-scope', 'model-analytics-list', 'model-analytics-detail', 'model-analytics-detail-title', 'model-analytics-detail-summary', 'model-analytics-detail-message', 'model-analytics-admin', 'model-analytics-users', 'model-analytics-close']) assert.match(modelsPage, new RegExp(`id="${id}"`), `models: ${id}`);
  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /function renderModelAnalytics/);
  assert.match(script, /function openModelAnalytics/);
  assert.match(script, /\/admin\/model-analytics/);
});

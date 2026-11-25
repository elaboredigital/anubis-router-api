import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('painel /global-stats expõe visão agregada com chave administrativa e período UTC', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-global-stats-page-'));
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

  assert.equal((await fetch(`${base}/admin/global-stats`)).status, 401);
  assert.equal((await fetch(`${base}/admin/global-stats?from=22/11/2026`, { headers: adminHeaders })).status, 400);
  const response = await fetch(`${base}/admin/global-stats?from=2026-11-22T00:00:00.000Z&to=2026-11-25T00:00:00.000Z`, { headers: adminHeaders });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.deepEqual(report.period, { from: '2026-11-22T00:00:00.000Z', to: '2026-11-25T00:00:00.000Z', clamped: false });
  assert.deepEqual(Object.keys(report.byStatus).sort(), ['cancelled', 'completed', 'failed', 'pending']);
  assert.equal(report.series.length, 3);
  assert.deepEqual(report.keys, { total: 0, active: 0, activeInPeriod: 0, revoked: 0, withPlan: 0, top: [] });
  assert.deepEqual(report.users, { total: 0, active: 0, activeInPeriod: 0, withActivityInPeriod: 0 });
  assert.equal(report.failureRate, 0);
  assert.deepEqual(report.failures, { attempts: 0, requests: 0, byStage: {}, byReason: {}, byProvider: {}, recent: [] });
  const text = JSON.stringify(report);
  for (const needle of ['hash', 'secret', 'prompt', 'response', 'apiKey']) assert.equal(text.includes(needle), false, needle);

  const created = await fetch(`${base}/admin/keys`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Cliente teste', planId: null }) });
  assert.equal(created.status, 201);
  const keyResult = await created.json();
  assert.match(keyResult.key, /^anubis_/);
  const after = await (await fetch(`${base}/admin/global-stats`, { headers: adminHeaders })).json();
  assert.equal(after.keys.total, 1);
  assert.equal(after.keys.active, 1);
  const afterText = JSON.stringify(after);
  assert.equal(afterText.includes(keyResult.key), false);
  assert.equal(afterText.includes(keyResult.hash || 'hash-secreto'), false);

  const html = await (await fetch(`${base}/`)).text();
  const pageSection = (markup, page) => {
    const start = markup.indexOf(`data-page="${page}"`);
    assert.notEqual(start, -1, `seção ${page}`);
    const end = markup.indexOf('data-page="', start + 1);
    return markup.slice(start, end === -1 ? markup.length : end);
  };
  const home = pageSection(html, 'home');
  const details = pageSection(html, 'global-stats');
  const client = pageSection(html, 'client-area');
  const kpiIds = ['global-admins', 'global-admin-sessions', 'global-users-total', 'global-users-active', 'global-keys-active', 'global-keys-total', 'global-requests', 'global-observed', 'global-tokens', 'global-profit', 'global-failure-rate', 'global-failures-count', 'global-spend', 'global-cost'];
  for (const id of kpiIds) {
    assert.match(home, new RegExp(`id="${id}"`), `home: ${id}`);
    assert.doesNotMatch(details, new RegExp(`id="${id}"`), `KPI ${id} não deve ficar em Estatísticas globais`);
    assert.doesNotMatch(client, new RegExp(`id="${id}"`), `KPI ${id} não deve ficar na área do cliente`);
  }
  for (const id of ['global-filter', 'global-from', 'global-to', 'global-clear', 'global-refresh', 'global-period-summary']) assert.match(home, new RegExp(`id="${id}"`), `home: ${id}`);
  for (const id of ['global-detail-filter', 'global-detail-from', 'global-detail-to', 'global-detail-clear', 'global-detail-refresh', 'global-detail-period-summary', 'global-status', 'global-failures', 'global-keys', 'global-models', 'global-providers', 'global-wallets', 'global-plans']) assert.match(details, new RegExp(`id="${id}"`), `detalhes: ${id}`);
  for (const id of ['client-area-stats-completed', 'client-area-stats-failed', 'client-area-stats-tokens', 'client-area-stats-spend']) assert.match(client, new RegExp(`id="${id}"`), `cliente: ${id}`);
  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /function renderGlobalStats/);
  assert.match(script, /report\.failures\?\.recent/);
  assert.match(script, /global-detail-period-summary/);
  assert.match(html, /href="\/global-stats"/);
});

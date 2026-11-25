import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('painel /system monitora o sistema e permite configurar a retenção', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-system-page-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../public', path.join(dir, 'public'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32) },
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
  const headers = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };

  const page = await fetch(`${base}/system`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-page="system"/);
  assert.match(html, /data-nav="system"/);
  for (const id of ['system-uptime', 'system-rss', 'system-request-bytes', 'system-runtime', 'system-storage', 'system-files', 'retention-form', 'retention-hours']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="stats-requests"/);
  assert.match(html, /Detalhes das requisições/);
  assert.match(html, /desfecho final prevalece/);

  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /system: '\/system'/);
  assert.match(script, /api\('\/admin\/system'\)/);
  assert.match(script, /renderRequestDetails/);
  assert.match(script, /className = 'request-attempt'/);
  const css = await (await fetch(`${base}/style.css`)).text();
  assert.match(css, /\.request-details\{/);
  assert.match(css, /\.system-row\{/);

  assert.equal((await fetch(`${base}/admin/system`)).status, 401);
  const initial = await (await fetch(`${base}/admin/system`, { headers })).json();
  assert.equal(initial.retention.retentionHours, 24);
  assert.ok(initial.process.uptimeSeconds >= 0);
  assert.ok(initial.traffic.responseBytesTotal > 0);
  assert.equal(initial.storage.mode, 'arquivos');
  assert.equal(JSON.stringify(initial).includes(adminKey), false);

  const invalid = await fetch(`${base}/admin/usage/retention`, { method: 'POST', headers, body: JSON.stringify({ retentionHours: 9999 }) });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /8760/);

  const saved = await fetch(`${base}/admin/usage/retention`, { method: 'POST', headers, body: JSON.stringify({ retentionHours: '168' }) });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.retentionHours, 168);
  assert.equal(savedBody.deleted, 0);
  assert.equal((await (await fetch(`${base}/admin/usage/retention`, { headers })).json()).retentionHours, 168);

  const cleared = await fetch(`${base}/admin/usage/retention`, { method: 'POST', headers, body: JSON.stringify({ retentionHours: null }) });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).retentionHours, null);
  assert.equal((await (await fetch(`${base}/admin/system`, { headers })).json()).retention.retentionHours, null);
});

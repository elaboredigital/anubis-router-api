import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('chat permanece dentro do mesmo painel, com a navegação e o login administrativos', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-chat-page-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../admin', path.join(dir, 'public'), { recursive: true });
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

  const page = await fetch(`${base}/chat`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control') || '', /no-store/);
  assert.match(page.headers.get('content-security-policy') || '', /connect-src 'self'/);
  const html = await page.text();
  assert.equal(html, await (await fetch(`${base}/`)).text());
  assert.match(html, /data-page="chat"/);
  assert.match(html, /href="\/chat" data-nav="chat"/);
  for (const id of ['chat-key', 'chat-remember', 'chat-load-models', 'chat-model', 'chat-transcript', 'chat-input', 'chat-send', 'chat-cancel', 'chat-status', 'chat-model-effective', 'chat-request-id', 'chat-fallback']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.equal(html.includes('Voltar ao painel'), false);
  assert.equal(html.includes('chat-shell'), false);
  assert.match(html, /id="dashboard"/);
  assert.match(html, /id="admin-key"/);

  const script = await (await fetch(`${base}/chat-web.js`)).text();
  assert.match(script, /\/v1\/models/);
  assert.match(script, /\/v1\/chat\/completions/);
  assert.match(script, /createSseDecoder/);
  assert.equal(script.includes('/admin/'), false);
  assert.equal(script.includes('anubis-admin'), false);
  assert.equal(script.includes('localStorage'), false);
  for (const asset of ['/chat-sse.js', '/panel-extras.css', '/app.js', '/style.css']) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200, asset);
    assert.match(await response.text(), /\S/);
  }
  const panelScript = await (await fetch(`${base}/app.js`)).text();
  assert.match(panelScript, /clientPaths/);
  assert.match(panelScript, /enterClientMode/);
  assert.match(await (await fetch(`${base}/panel-extras.css`)).text(), /client-mode/);

  const adminPage = await (await fetch(`${base}/`)).text();
  assert.match(adminPage, /href="\/chat" data-nav="chat"/);
  assert.match(adminPage, /id="client-open-chat"/);

  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  assert.equal((await fetch(`${base}/admin/status`)).status, 401);
  const denied = await fetch(`${base}/chat`, { headers: { origin: 'https://example.com' } });
  assert.equal(denied.status, 403);
});

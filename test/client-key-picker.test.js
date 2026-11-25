import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('admin seleciona chave existente sem revelar o segredo, usando sessão temporária', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-key-picker-'));
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
  const adminHeaders = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
  const bearer = token => ({ authorization: `Bearer ${token}`, accept: 'application/json' });
  const request = (route, options = {}) => fetch(`${base}${route}`, options);
  const post = (route, token, data) => request(route, { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify(data) });

  const html = await (await request('/chat')).text();
  for (const id of ['chat-key-picker', 'chat-key-picker-status', 'client-area-key-picker', 'client-area-key-picker-status', 'referral-key-picker', 'referral-key-picker-status']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /Chaves cadastradas \(admin\)/);
  assert.match(html, /Sem revelar a chave/);
  const panel = await (await request('/app.js')).text();
  assert.match(panel, /A chave completa não foi exibida/);
  assert.match(panel, /\/admin\/keys\/session/);
  assert.match(panel, /anubis-client-session/);
  assert.match(panel, /renderClientKeyPickers/);
  for (const file of ['/chat-web.js', '/account.js', '/referrals-client.js', '/chat-sse.js']) {
    const script = await (await request(file)).text();
    assert.match(script, /anubis-client-session|revokeClientSession|readClientSession/);
    assert.equal(script.includes('/admin/'), false, file);
    assert.equal(script.includes('anubis-admin'), false, file);
    assert.equal(script.includes('localStorage'), false, file);
  }
  const css = await (await request('/panel-extras.css')).text();
  assert.match(css, /body\.client-mode \.admin-key-picker\{display:none\}/);

  assert.equal((await post('/admin/keys/session', 'chave-administrativa-errada', { keyId: 'inexistente' })).status, 401);
  assert.equal((await post('/admin/keys/session', adminKey, { keyId: 'inexistente' })).status, 404);
  const created = await request('/admin/keys', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Titular de teste' }) });
  assert.equal(created.status, 201);
  const { key: fullKey, id: keyId } = await created.json();

  const listing = await (await request('/admin/keys', { headers: adminHeaders })).json();
  const shown = listing.keys.find(item => item.id === keyId);
  assert.equal(shown.name, 'Titular de teste');
  assert.match(shown.prefix, /^anubis_/);
  assert.equal(JSON.stringify(listing).includes(fullKey), false);

  const selected = await post('/admin/keys/session', adminKey, { keyId });
  assert.equal(selected.status, 201);
  const first = await selected.json();
  assert.match(first.token, /^anubis_sess_[0-9A-Za-z_-]+$/);
  assert.equal(first.keyId, keyId);
  assert.equal(first.label, 'Titular de teste');
  assert.match(first.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(JSON.stringify(first).includes(fullKey), false);
  assert.equal(JSON.stringify(first).includes('hash'), false);

  assert.equal((await request('/v1/models', { headers: bearer(first.token) })).status, 200);
  const summary = await (await request('/me/summary', { headers: bearer(first.token) })).json();
  assert.equal(summary.account.id, keyId);
  assert.equal(JSON.stringify(summary).includes(fullKey), false);
  assert.equal(JSON.stringify(summary).includes(first.token), false);
  assert.equal((await request('/admin/status', { headers: bearer(first.token) })).status, 401);

  const again = await (await post('/admin/keys/session', adminKey, { keyId })).json();
  assert.notEqual(again.token, first.token);
  assert.equal((await request('/me/summary', { headers: bearer(first.token) })).status, 401, 'token anterior deve ser revogado');
  assert.equal((await request('/me/summary', { headers: bearer(again.token) })).status, 200);

  const revoked = await request('/client-session', { method: 'DELETE', headers: bearer(again.token) });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { revoked: true });
  assert.equal((await request('/me/summary', { headers: bearer(again.token) })).status, 401);
  assert.equal((await request('/me/summary', { headers: bearer(fullKey) })).status, 200, 'a chave original continua válida');

  const relogin = await (await post('/admin/keys/session', adminKey, { keyId })).json();
  assert.equal((await request('/admin/keys/session', { method: 'DELETE', headers: adminHeaders })).status, 200);
  assert.equal((await request('/me/summary', { headers: bearer(relogin.token) })).status, 401);

  const last = await (await post('/admin/keys/session', adminKey, { keyId })).json();
  assert.equal((await request(`/admin/keys/revoke`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: keyId }) })).status, 200);
  assert.equal((await request('/me/summary', { headers: bearer(last.token) })).status, 401);
  assert.equal((await post('/admin/keys/session', adminKey, { keyId })).status, 404);

  const persisted = await readFile(path.join(dir, 'data', 'api-keys.json'), 'utf8');
  assert.equal(persisted.includes(fullKey), false);
  assert.equal(persisted.includes(last.token), false);
});

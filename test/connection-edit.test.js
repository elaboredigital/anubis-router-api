import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('admin edita conexão sem expor segredo e revalida quando a credencial muda', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-connection-edit-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../admin', path.join(dir, 'public'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const keys = new Set(['upstream-OLD-1234567890', 'upstream-NEW-0987654321']);
  const requests = [];
  const mock = http.createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization || '' });
    if (req.method === 'GET') {
      const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (!keys.has(key)) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(req.url.startsWith('/v1/models')
        ? { data: [{ id: 'remote/model', display_name: 'Modelo', modality: 'chat', billing_type: 'request', pricing: { request: '0.02', currency: 'USD' } }] }
        : { plan: 'free', wallet: { balance_usd: '1.000000', held_usd: '0' }, free_tokens: { remaining: 12, limit_per_day: 5000 } }));
    }
    res.writeHead(405); res.end();
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), TEST_UPSTREAM_URL: `http://127.0.0.1:${mock.address().port}`, ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); await new Promise(resolve => mock.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`servidor encerrou com ${code}`))); });
  const base = `http://127.0.0.1:${port}`;
  const adminHeaders = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
  const edit = (id, data) => fetch(`${base}/admin/connections/${id}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify(data) });
  const json = async response => ({ status: response.status, body: await response.json() });

  let response = await fetch(`${base}/admin/connections`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ provider: 'xkiro', name: 'Original', key: 'upstream-OLD-1234567890' }) });
  assert.equal(response.status, 201);
  const id = (await response.json()).connection.id;

  response = await json(await edit(id, { name: 'Renomeada' }));
  assert.equal(response.status, 200);
  assert.equal(response.body.connection.name, 'Renomeada');
  assert.equal(response.body.connection.provider, 'xkiro');
  assert.equal(response.body.connection.validationPath, '/v1/usage');
  assert.equal(JSON.stringify(response.body).includes('upstream-OLD'), false);
  const beforeRefresh = requests.length;
  response = await json(await edit(id, { name: 'Sem revalidacao' }));
  assert.equal(response.status, 200);
  assert.equal(response.body.connection.name, 'Sem revalidacao');
  assert.equal(requests.length, beforeRefresh, 'alterar apenas o nome não consulta o fornecedor');

  keys.delete('upstream-OLD-1234567890');
  response = await json(await edit(id, { key: 'invalida-curta' }));
  assert.equal(response.status, 400);
  response = await json(await edit(id, { validationPath: '../segredo' }));
  assert.equal(response.status, 400);
  response = await json(await edit(id, { provider: 'maxrouter' }));
  assert.equal(response.status, 400);
  response = await json(await edit('id-inexistente', { name: 'Teste' }));
  assert.equal(response.status, 404);

  const beforeKeyChange = requests.length;
  response = await json(await edit(id, { name: 'Chave nova', key: 'upstream-NEW-0987654321' }));
  assert.equal(response.status, 200);
  assert.equal(response.body.connection.status, 'valid');
  assert.equal(JSON.stringify(response.body).includes('upstream-NEW'), false);
  const afterKeyChange = requests.slice(beforeKeyChange);
  assert.ok(afterKeyChange.some(item => item.authorization === 'Bearer upstream-NEW-0987654321'));
  assert.equal(afterKeyChange.some(item => item.authorization === 'Bearer upstream-OLD-1234567890'), false);
  response = await fetch(`${base}/admin/connections/${id}/refresh`, { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal(response.status, 200);

  const raw = await readFile(path.join(dir, 'data', 'credentials.json'), 'utf8');
  for (const secret of ['upstream-OLD-1234567890', 'upstream-NEW-0987654321']) assert.equal(raw.includes(secret), false);

  const html = await (await fetch(`${base}/providers`)).text();
  for (const elementId of ['provider-form-title', 'provider-links', 'provider-cancel', 'provider-key-label']) assert.match(html, new RegExp(`id="${elementId}"`), `HTML: ${elementId}`);
  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /editingConnectionId/);
  assert.match(script, /method: 'PATCH'/);
  assert.match(script, /provider-links/);
  const profiles = await (await fetch(`${base}/admin/connectors`, { headers: adminHeaders })).json();
  assert.equal(profiles.connectors.find(item => item.id === 'maxrouter').site, 'https://www.maxrouter.ai/');
});

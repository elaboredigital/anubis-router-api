import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('admin entra com usuário e senha, troca a senha e a chave continua valendo', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-admin-login-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32), DATABASE_URL: '', ANUBIS_ADMIN_USER: 'Gestor', ANUBIS_ADMIN_PASSWORD: 'senha-inicial-123' };
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.on('data', chunk => { if (/Anubis Router: http/.test(String(chunk))) resolve(); }); child.once('exit', code => reject(new Error(`server exited ${code}`))); });
  const base = `http://127.0.0.1:${port}`;
  const post = (url, data, token) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });

  const stored = await readFile(path.join(dir, 'data', 'admin-accounts.json'), 'utf8');
  assert.doesNotMatch(stored, /senha-inicial-123/, 'senha só como hash');
  assert.equal((await fetch(`${base}/admin/routes`)).status, 401);
  assert.equal((await post('/admin/login', { username: 'gestor', password: 'errada' })).status, 401);
  assert.equal((await post('/admin/login', { username: 'ninguem', password: 'senha-inicial-123' })).status, 401);
  let response = await post('/admin/login', { username: 'GESTOR', password: 'senha-inicial-123' });
  assert.equal(response.status, 200);
  const { token, username } = await response.json();
  assert.match(token, /^anubis_adm_/);
  assert.equal(username, 'gestor');
  assert.equal((await fetch(`${base}/admin/routes`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.deepEqual(await (await fetch(`${base}/admin/me`, { headers: { authorization: `Bearer ${token}` } })).json(), { username: 'gestor', viaKey: false });
  assert.equal((await fetch(`${base}/admin/routes`, { headers: { authorization: `Bearer ${adminKey}` } })).status, 200, 'chave de emergência continua valendo');

  // Troca de senha e de usuário: exige a senha atual e derruba as outras sessões.
  const other = (await (await post('/admin/login', { username: 'gestor', password: 'senha-inicial-123' })).json()).token;
  assert.equal((await post('/admin/password', { current: 'errada', next: 'nova-senha-forte-1' }, token)).status, 400);
  assert.equal((await post('/admin/password', { current: 'senha-inicial-123', next: 'curta' }, token)).status, 400);
  response = await post('/admin/password', { current: 'senha-inicial-123', next: 'nova-senha-forte-1', username: 'alan.admin' }, token);
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${base}/admin/routes`, { headers: { authorization: `Bearer ${other}` } })).status, 401, 'outra sessão encerrada');
  assert.equal((await fetch(`${base}/admin/routes`, { headers: { authorization: `Bearer ${token}` } })).status, 200, 'sessão atual continua');
  assert.equal((await post('/admin/login', { username: 'gestor', password: 'senha-inicial-123' })).status, 401);
  assert.equal((await post('/admin/login', { username: 'alan.admin', password: 'nova-senha-forte-1' })).status, 200);

  assert.equal((await post('/admin/logout', {}, token)).status, 200);
  assert.equal((await fetch(`${base}/admin/routes`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
});

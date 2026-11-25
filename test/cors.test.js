import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('API aceita preflight das origens configuradas e devolve cabeçalhos CORS', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-cors-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port),
      ANUBIS_ADMIN_KEY: 'admin-key-1234567890123', ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32),
      ANUBIS_PUBLIC_URL: 'https://anubisrouter.com, https://admin.anubisrouter.com',
    },
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
  const origin = 'https://admin.anubisrouter.com';

  const robots = await fetch(`${base}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Disallow: \//);
  assert.equal(robots.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await fetch(`${base}/v1/models`)).headers.get('x-robots-tag'), 'noindex, nofollow');

  const preflight = await fetch(`${base}/v1/models`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /authorization/);
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /GET/);

  const response = await fetch(`${base}/v1/models`, { headers: { origin } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);

  const local = await fetch(`${base}/admin/status`, { headers: { origin: 'http://127.0.0.1:3000' } });
  assert.equal(local.status, 401);
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3000');

  const denied = await fetch(`${base}/v1/models`, { headers: { origin: 'https://exemplo.invalid' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

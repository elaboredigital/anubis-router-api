import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('painel serve a página Conectar ferramenta e o catálogo sem exigir a chave administrativa', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-connect-test-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../admin', path.join(dir, 'public'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
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

  const page = await fetch(`${base}/connect`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  const html = await page.text();
  assert.match(html, /data-page="connect"/);
  assert.match(html, /Conectar ferramenta/);
  for (const id of ['connect-base-url', 'connect-search', 'connect-category', 'connect-status', 'connect-os', 'connect-message', 'connect-report', 'connect-test', 'connect-list']) assert.match(html, new RegExp(`id="${id}"`));
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /pagePaths = \{[^\n]*connect: '\/connect'/);
  assert.match(script, /connect-tools\.json/);
  assert.match(script, /\/admin\/connect\/diagnose/);

  const catalog = await fetch(`${base}/connect-tools.json`);
  assert.equal(catalog.status, 200);
  assert.match(catalog.headers.get('content-type'), /application\/json/);
  const tools = await catalog.json();
  assert.ok(tools.some(tool => tool.id === 'vscode-windsurf'));
  assert.ok(tools.some(tool => tool.id === 'n8n' && tool.status === 'em homologação'));
  assert.equal(tools.some(tool => tool.status === 'disponível'), true);
  assert.equal(JSON.stringify(tools).includes('<SUA_CHAVE_ANUBIS>'), true);

  const unauthorized = await fetch(`${base}/admin/connect/diagnose`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);
  const keysFile = path.join(dir, 'data', 'api-keys.json');
  const usageFile = path.join(dir, 'data', 'usage.jsonl');
  assert.equal(existsSync(keysFile), false);
  assert.equal(existsSync(usageFile), false);
  const diagnosis = await fetch(`${base}/admin/connect/diagnose`, {
    method: 'POST',
    headers: { authorization: `Bearer ${'admin-key-1234567890123'}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(diagnosis.status, 200);
  const report = await diagnosis.json();
  assert.equal(report.ok, false);
  assert.match(report.scope, /não valida a ferramenta externa|não consome inferência/);
  assert.equal(report.checks.find(c => c.id === 'authentication').ok, true);
  assert.equal(report.checks.find(c => c.id === 'models').ok, false);
  assert.equal(report.checks.find(c => c.id === 'keys').ok, false);
  assert.doesNotMatch(JSON.stringify(report), /Bearer|diagnostic-|secret|hash|anubis_[A-Za-z0-9_-]{8,}/i);
  assert.equal(existsSync(keysFile), false);
  assert.equal(existsSync(usageFile), false, 'o diagnóstico não pode registrar inferência');
  assert.equal((await fetch(`${base}/admin/keys`)).status, 401);
});

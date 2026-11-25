import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('painel serve a página de planos com limites, elegibilidade e preço de venda', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-plans-test-'));
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

  const page = await fetch(`${base}/plans`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-page="plans"/);
  assert.match(html, /Planos e limites/);
  for (const id of ['plan-form', 'plan-name', 'plan-kind', 'plan-requests', 'plan-tokens', 'plan-multiplier', 'plan-models', 'plan-active', 'plan-list', 'provider-usage']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /multiplicador padrão/i);
  assert.match(html, /80%/);
  assert.match(html, /direitos de revenda/i);

  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /pagePaths = \{[^\n]*plans: '\/plans'/);
  assert.match(script, /\/admin\/plans/);
  assert.match(script, /\/admin\/keys\/plan/);
  assert.match(script, /marginPercent/);

  assert.equal((await fetch(`${base}/admin/plans`)).status, 401);
  const report = await (await fetch(`${base}/admin/plans`, { headers: { authorization: 'Bearer admin-key-1234567890123' } })).json();
  assert.equal(report.defaultMultiplier, '5');
  assert.equal(report.plans[0].name, 'Gratuito');
  assert.equal(report.plans[0].models.length, 0);
  assert.deepEqual(report.providerUsage, []);
});

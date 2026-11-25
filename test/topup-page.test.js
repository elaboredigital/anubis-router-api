import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('painel serve top up PAYG com recargas simuladas e plano pronto', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-topup-test-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../public', path.join(dir, 'public'), { recursive: true });
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

  const page = await fetch(`${base}/topup`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-page="topup"/);
  assert.match(html, /Top up PAYG/);
  assert.match(html, /data-nav="topup"/);
  for (const id of ['topup-create-plan', 'topup-plan-message', 'topup-wallets-count', 'topup-credits', 'topup-consumed', 'topup-pending', 'topup-form', 'topup-key', 'topup-amount', 'topup-currency', 'topup-note', 'topup-message', 'topup-wallet-list', 'topup-history']) assert.match(html, new RegExp(`id="${id}"`));
  for (const amount of ['10', '20', '50', '100', '200', '500']) assert.match(html, new RegExp(`data-amount="${amount}"`));
  assert.match(html, /sem checkout/i);
  assert.match(html, /não é cobrado/i);

  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /topup: '\/topup'/);
  assert.match(script, /\/admin\/topup/);
  assert.match(script, /topup-create-plan/);
  assert.match(script, /idempotencyKey/);
  assert.match(script, /kind: 'payg'/);

  const plansPage = await (await fetch(`${base}/plans`)).text();
  assert.match(plansPage, /id="plan-currency"/);
  assert.match(plansPage, /option value="payg"/);

  assert.equal((await fetch(`${base}/admin/topup`)).status, 401);
  const report = await (await fetch(`${base}/admin/topup`, { headers: { authorization: 'Bearer admin-key-1234567890123' } })).json();
  assert.deepEqual(report.wallets, []);
  assert.deepEqual(report.topups, []);
  assert.equal(report.scope, 'manual_topups');
  const plans = await (await fetch(`${base}/admin/plans`, { headers: { authorization: 'Bearer admin-key-1234567890123' } })).json();
  assert.equal(plans.plans.some(plan => plan.kind === 'payg'), false);
});

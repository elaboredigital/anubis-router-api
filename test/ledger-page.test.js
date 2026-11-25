import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('painel serve a página de razão financeira com versões e reconciliação', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-ledger-test-'));
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

  const page = await fetch(`${base}/ledger`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-page="ledger"/);
  assert.match(html, /Razão financeira/);
  for (const id of ['ledger-reconcile', 'ledger-counts', 'ledger-pending', 'ledger-totals', 'price-history', 'ledger-entries', 'ledger-message']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /não são somados entre moedas diferentes/i);
  assert.match(html, /nada é debitado, creditado, reservado/i);

  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /ledger: '\/ledger'/);
  assert.match(script, /\/admin\/ledger/);
  assert.match(script, /\/admin\/ledger\/reconcile/);
  assert.match(script, /versionIds/);

  assert.equal((await fetch(`${base}/admin/ledger`)).status, 401);
  const report = await (await fetch(`${base}/admin/ledger`, { headers: { authorization: 'Bearer admin-key-1234567890123' } })).json();
  assert.equal(report.history[0].id, 'baseline-default');
  assert.equal(report.history[0].multiplier, '5');
  assert.equal(report.history[0].effectiveAt, null);
  assert.deepEqual(report.entries, []);
  assert.deepEqual(report.summary.counts, { completed: 0, entries: 0, unpriced: 0, pendingConversion: 0 });
  const reconcile = await (await fetch(`${base}/admin/ledger/reconcile`, { method: 'POST', headers: { authorization: 'Bearer admin-key-1234567890123' } })).json();
  assert.equal(reconcile.added, 0);
});

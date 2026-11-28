import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('indicações ficam no mesmo painel, com acompanhamento no admin e isolamento no cliente', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-referrals-'));
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
  const clientHeaders = key => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
  const request = (route, options = {}) => fetch(`${base}${route}`, options);
  const post = (route, key, data) => request(route, { method: 'POST', headers: clientHeaders(key), body: JSON.stringify(data) });

  const index = await (await request('/')).text();
  for (const page of ['/referrals', '/indicacoes', '/chat', '/minha-conta']) {
    const response = await request(page);
    assert.equal(response.status, 200, page);
    assert.equal(await response.text(), index, page);
  }
  for (const id of ['referral-program', 'referral-totals', 'referral-owners', 'referral-register-form', 'referral-qualify-form', 'referral-status-form', 'referral-move-form', 'referral-audit', 'referral-access-key', 'referral-client-content', 'referral-client-stats', 'referral-client-list']) {
    assert.match(index, new RegExp(`id="${id}"`), id);
  }
  assert.match(index, /data-nav="referrals"/);
  assert.match(index, /data-nav="referrals-client"/);
  assert.equal((await request('/referrals-client.js')).status, 200);
  const clientScript = await (await request('/referrals-client.js')).text();
  assert.match(clientScript, /\/me\/referrals/);
  assert.equal(clientScript.includes('/admin/'), false);
  assert.equal(clientScript.includes('localStorage'), false);
  assert.equal(clientScript.includes('innerHTML'), false);
  const panelScript = await (await request('/app.js')).text();
  assert.match(panelScript, /\/indicacoes/);
  assert.match(panelScript, /renderReferrals\(referralResult\)/);

  assert.equal((await request('/admin/referrals')).status, 401);
  assert.equal((await request('/admin/referrals/qualify', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: 'inexistente' }) })).status, 404);

  const firstKey = await request('/admin/keys', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Titular A' }) });
  const secondKey = await request('/admin/keys', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Titular B' }) });
  assert.equal(firstKey.status, 201);
  assert.equal(secondKey.status, 201);
  const { key: keyA, id: idA } = await firstKey.json();
  const { key: keyB, id: idB } = await secondKey.json();

  let report = await (await request('/admin/referrals', { headers: adminHeaders })).json();
  assert.equal(report.owners.length, 2);
  const codeA = report.owners.find(owner => owner.id === idA).code;
  assert.match(codeA, /^[0-9A-F]{10}$/);
  assert.equal(JSON.stringify(report).includes(keyA), false);
  assert.equal(JSON.stringify(report).includes(keyB), false);
  assert.equal(JSON.stringify(report).includes('hash'), false);

  const contact = 'alanj2diniz@gmail.com';
  const created = await post('/admin/referrals', adminKey, { ownerKeyId: idA, contact, note: 'cadastro local' });
  assert.equal(created.status, 201);
  const referralA = (await created.json()).referral;
  assert.equal(referralA.contact, 'a***@***.com');
  assert.equal(JSON.stringify(referralA).includes(contact), false);
  assert.equal((await post('/admin/referrals', adminKey, { ownerKeyId: 'inexistente', contact })).status, 400);

  const oldDates = ['2020-01-01T00:00:00.000Z', '2020-02-01T00:00:00.000Z', '2020-03-01T00:00:00.000Z', '2020-04-01T00:00:00.000Z'];
  const saved = [referralA];
  for (let i = 1; i < 4; i += 1) {
    const next = await post('/admin/referrals', adminKey, { ownerKeyId: idA, contact: `pessoa${i}@exemplo.com` });
    assert.equal(next.status, 201);
    saved.push((await next.json()).referral);
  }
  for (let i = 0; i < saved.length; i += 1) {
    const qualified = await post('/admin/referrals/qualify', adminKey, { id: saved[i].id, depositAmount: '20.00', qualifiedAt: oldDates[i] });
    const payload = await qualified.json();
    assert.equal(qualified.status, 200, `${i}: ${JSON.stringify(payload)}`);
    const item = payload.referral;
    assert.equal(item.rewardAmount, '5.00');
    assert.match(item.holdUntil, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  assert.equal((await post('/admin/referrals/qualify', adminKey, { id: saved[0].id, depositAmount: '19.00' })).status, 400);
  assert.equal((await post('/admin/referrals/qualify', adminKey, { id: saved[0].id, depositAmount: '20.00', currency: 'EUR' })).status, 400);
  assert.equal((await post('/admin/referrals/status', adminKey, { id: saved[0].id, status: 'rejeitada' })).status, 400);

  report = await (await request('/admin/referrals', { headers: adminHeaders })).json();
  assert.equal(report.totals.qualified, 4);
  assert.equal(report.totals.available.amount, '20.00');
  assert.equal(report.totals.canMove, true);
  assert.equal(report.totals.movableIds.length, 4);
  const moved = await post('/admin/referrals/move-credit', adminKey, { ids: report.totals.movableIds });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).moved, 4);

  const clientReport = await (await request('/me/referrals', { headers: clientHeaders(keyA) })).json();
  assert.equal(clientReport.code, codeA);
  assert.match(clientReport.link, new RegExp(`/signup\\?ref=${codeA}$`));
  assert.equal(clientReport.code.includes('hash'), false);
  assert.equal(clientReport.referrals.length, 4);
  assert.equal(clientReport.stats.earned.amount, '20.00');
  assert.equal(clientReport.stats.signups, 4);
  const clientText = JSON.stringify(clientReport);
  assert.equal(clientText.includes(contact), false);
  assert.equal(clientText.includes(keyA), false);
  assert.equal(clientText.includes(idB), false);
  assert.equal(clientText.includes('hash'), false);

  const otherReport = await (await request('/me/referrals', { headers: clientHeaders(keyB) })).json();
  assert.equal(otherReport.referrals.length, 0);
  assert.equal(otherReport.stats.qualified, 0);
  assert.notEqual(otherReport.code, codeA);
  assert.equal((await request('/admin/referrals', { headers: clientHeaders(keyA) })).status, 401);
  assert.equal((await request('/me/referrals', { headers: clientHeaders('anubis_invalida') })).status, 401);

  report = await (await request('/admin/referrals', { headers: adminHeaders })).json();
  assert.deepEqual([...new Set(report.audit.map(event => event.action))].sort(), ['move_referral_credit', 'qualify_referral', 'register_referral']);
  const auditText = JSON.stringify(report.audit);
  assert.equal(auditText.includes(contact), false);
  assert.equal(auditText.includes(keyA), false);
  const persisted = await readFile(path.join(dir, 'data', 'referrals.json'), 'utf8');
  assert.equal(persisted.includes(contact), false);
  assert.equal(persisted.includes(keyA), false);
});

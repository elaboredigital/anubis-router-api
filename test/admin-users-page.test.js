import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('painel /users reúne titulares, saldo, chaves e indicações sem expor segredos', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-users-page-'));
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
  const request = (route, options = {}) => fetch(`${base}${route}`, options);
  const api = (route, data, method = 'POST', headers = adminHeaders) => request(route, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });

  const index = await (await request('/')).text();
  const usersPage = await request('/users');
  assert.equal(usersPage.status, 200);
  assert.equal(await usersPage.text(), index);
  assert.match(index, /data-nav="users"/);
  for (const id of ['user-summary', 'user-search', 'user-list', 'user-facts', 'user-wallets', 'user-keys', 'user-plan-form', 'user-key-form', 'user-topup-form', 'user-status-form', 'user-referral-list', 'user-referral-register-form', 'user-referral-qualify-form', 'user-referral-status-form', 'user-referral-move-form']) {
    assert.match(index, new RegExp(`id="${id}"`), id);
  }
  const script = await (await request('/app.js')).text();
  assert.match(script, /\/admin\/users/);
  assert.match(script, /function renderUsers/);
  assert.match(script, /user-referral-register-form/);

  assert.equal((await request('/admin/users')).status, 401);
  const payg = await (await api('/admin/plans', { name: 'PAYG usuários', kind: 'payg', currency: 'USD', active: true, selfService: true })).json();
  assert.equal(payg.plan.kind, 'payg');
  const first = await (await api('/admin/keys', { name: 'Titular A', planId: payg.plan.id })).json();
  const second = await (await api('/admin/keys', { name: 'Titular B', planId: null })).json();
  assert.match(first.key, /^anubis_/);
  assert.match(second.key, /^anubis_/);

  let report = await (await request('/admin/users', { headers: adminHeaders })).json();
  assert.equal(report.users.length, 2);
  assert.equal(report.totals.users, 2);
  assert.equal(report.users.find(user => user.id === first.id).keyCount, 1);

  const created = await api(`/admin/users/${first.id}/keys`, { name: 'Dev A', planId: payg.plan.id });
  assert.equal(created.status, 201);
  const derived = await created.json();
  assert.match(derived.key, /^anubis_/);
  assert.equal(derived.rootId, first.id);
  assert.equal(JSON.stringify(derived).includes('hash'), false);

  const topup = await api('/admin/topup', { keyId: first.id, amount: '10.00', currency: 'USD', note: 'recarga A', idempotencyKey: 'user-topup-a' });
  assert.equal(topup.status, 201);
  const duplicate = await api('/admin/topup', { keyId: first.id, amount: '10.00', currency: 'USD', note: 'recarga A', idempotencyKey: 'user-topup-a' });
  assert.equal((await duplicate.json()).duplicate, true);
  const childTopup = await api('/admin/topup', { keyId: derived.id, amount: '5.50', currency: 'USD', note: 'recarga filha', idempotencyKey: 'user-topup-child' });
  assert.equal(childTopup.status, 201);

  const referral = await api('/admin/referrals', { ownerKeyId: first.id, contact: 'ana@exemplo.com', note: 'cadastro local' });
  assert.equal(referral.status, 201);
  const referralId = (await referral.json()).referral.id;
  const qualified = await api('/admin/referrals/qualify', { id: referralId, depositAmount: '10.00', qualifiedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(qualified.status, 200);

  report = await (await request('/admin/users', { headers: adminHeaders })).json();
  const ana = report.users.find(user => user.id === first.id);
  assert.equal(ana.keyCount, 2);
  assert.equal(ana.activeKeys, 2);
  assert.deepEqual(ana.wallets.find(item => item.currency === 'USD'), { currency: 'USD', keys: 2, credits: '15.5', consumed: '0', balance: '15.5', requests: 0, pending: 0, negative: false });
  assert.equal(ana.referrals.stats.signups, 1);
  assert.equal(ana.referrals.stats.qualified, 1);
  assert.equal(ana.referrals.records.length, 1);
  assert.equal(ana.referrals.records[0].contact, 'a***@***.com');
  assert.match(ana.referrals.code, /^[0-9A-F]{10}$/);

  const session = await (await api('/admin/keys/session', { keyId: first.id })).json();
  const clientHeaders = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };
  assert.equal((await request('/me/summary', { headers: clientHeaders })).status, 200);
  const block = await api(`/admin/users/${first.id}/active`, { active: false });
  assert.equal(block.status, 200);
  assert.equal((await block.json()).updated, 2);
  assert.equal((await request('/me/summary', { headers: clientHeaders })).status, 401);
  const blocked = await (await request('/admin/users', { headers: adminHeaders })).json();
  assert.equal(blocked.users.find(user => user.id === first.id).blocked, true);
  assert.equal(blocked.users.find(user => user.id === first.id).activeKeys, 0);

  const unblock = await api(`/admin/users/${first.id}/active`, { active: true });
  assert.equal(unblock.status, 200);
  assert.equal((await unblock.json()).updated, 2);
  const freePlans = await (await request('/admin/plans', { headers: adminHeaders })).json();
  const free = freePlans.plans.find(plan => plan.id === 'free');
  const planChange = await api(`/admin/users/${first.id}/plan`, { planId: free.id });
  assert.equal(planChange.status, 200);
  assert.equal((await planChange.json()).updated, 2);
  const changed = await (await request('/admin/users', { headers: adminHeaders })).json();
  assert.deepEqual(changed.users.find(user => user.id === first.id).keys.map(key => key.planId), ['free', 'free']);

  assert.equal((await api(`/admin/users/${derived.id}/active`, { active: false })).status, 404);
  assert.equal((await api(`/admin/users/${first.id}/plan`, { planId: 'inexistente' })).status, 400);
  assert.equal((await api(`/admin/users/${first.id}/keys`, { name: '', planId: null })).status, 400);
  assert.equal((await api(`/admin/users/${first.id}/active`, { active: 'nao' })).status, 400);

  const finalText = JSON.stringify(await (await request('/admin/users', { headers: adminHeaders })).json());
  for (const needle of [first.key, second.key, derived.key, 'ana@exemplo.com', 'hash']) assert.equal(finalText.includes(needle), false, needle);
});

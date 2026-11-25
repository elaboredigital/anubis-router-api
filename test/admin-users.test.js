import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_KEYS_PER_OWNER } from '../src/client-self-service.js';
import { normalizeReferral } from '../src/referrals.js';
import { buildAdminUsers, findUserFamily, validateUserActive, validateUserKeyCreate, validateUserPlan } from '../src/admin-users.js';

test('buildAdminUsers agrupa chaves pelo dono e soma saldo apenas dentro da mesma moeda', () => {
  const keys = [
    { id: 'root-a', name: 'Ana', prefix: 'anubis_ana12345', active: true, createdAt: '2026-01-01T00:00:00.000Z', planId: 'payg-usd', hash: 'hash-secreto-a' },
    { id: 'child-a', parentId: 'root-a', name: 'Dev Ana', prefix: 'anubis_dev12345', active: true, createdAt: '2026-01-02T00:00:00.000Z', planId: 'payg-usd' },
    { id: 'root-b', name: 'Bruno', prefix: 'anubis_bru12345', active: false, createdAt: '2026-01-03T00:00:00.000Z', planId: null },
  ];
  const plans = [{ id: 'payg-usd', name: 'PAYG USD', kind: 'payg', currency: 'USD', active: true, models: [] }];
  const topups = [
    { id: 't1', keyId: 'root-a', amount: '10.00', currency: 'USD' },
    { id: 't1', keyId: 'root-a', amount: '10.00', currency: 'USD' },
    { id: 't2', keyId: 'child-a', amount: '5.50', currency: 'USD' },
    { id: 't3', keyId: 'root-a', amount: '20.00', currency: 'EUR' },
  ];
  const entries = [
    { id: 'e1', keyId: 'root-a', status: 'settled', sale: '2.00', currency: 'USD', saleCurrency: 'USD', requestId: 'r1' },
    { id: 'e2', keyId: 'child-a', status: 'pending_conversion', sale: null, currency: 'USD', saleCurrency: null, requestId: 'r2' },
  ];
  const records = [{ requestId: 'r1', clientKeyId: 'root-a' }];
  const referrals = [
    {
      ...normalizeReferral({ ownerKeyId: 'root-a', contact: 'ana@exemplo.com' }),
      id: 'indicacao-a', status: 'qualificada', rewardAmount: '1.00', rewardCurrency: 'USD', holdUntil: '2020-01-01T00:00:00.000Z',
    },
    { ...normalizeReferral({ ownerKeyId: 'root-b', contact: 'bruno@exemplo.com' }), id: 'indicacao-b' },
  ];
  const codes = { 'root-a': 'AAAAAAAAAA', 'root-b': 'BBBBBBBBBB' };

  const report = buildAdminUsers({ keys, plans, topups, entries, records, referrals, codes, now: '2026-11-25T00:00:00.000Z' });
  assert.equal(report.users.length, 2);
  assert.deepEqual(report.limits, { maxKeys: MAX_KEYS_PER_OWNER });

  const ana = report.users.find(user => user.id === 'root-a');
  assert.equal(ana.keyCount, 2);
  assert.equal(ana.activeKeys, 2);
  assert.equal(ana.blocked, false);
  assert.deepEqual(ana.wallets.find(item => item.currency === 'USD'), { currency: 'USD', keys: 2, credits: '15.5', consumed: '2', balance: '13.5', requests: 1, pending: 1, negative: false });
  assert.deepEqual(ana.wallets.find(item => item.currency === 'EUR'), { currency: 'EUR', keys: 1, credits: '20', consumed: '0', balance: '20', requests: 0, pending: 0, negative: false });
  assert.deepEqual(ana.referrals.stats.earned, { amount: '0.00', currency: 'USD' });
  assert.equal(ana.referrals.stats.qualified, 1);
  assert.equal(ana.referrals.stats.signups, 1);
  assert.equal(ana.referrals.records.length, 1);
  assert.equal(ana.referrals.code, 'AAAAAAAAAA');

  const bruno = report.users.find(user => user.id === 'root-b');
  assert.equal(bruno.blocked, true);
  assert.deepEqual(bruno.wallets, []);
  assert.equal(bruno.referrals.stats.signups, 1);
  assert.equal(bruno.referrals.stats.qualified, 0);

  assert.equal(report.totals.users, 2);
  assert.equal(report.totals.activeUsers, 1);
  assert.equal(report.totals.blockedUsers, 1);
  assert.equal(report.totals.keys, 3);

  const text = JSON.stringify(report);
  for (const needle of ['hash-secreto-a', 'anubis_ana12345anubis_dev12345', 'ana@exemplo.com', 'bruno@exemplo.com']) assert.equal(text.includes(needle), false, needle);
});

test('findUserFamily aceita apenas raízes existentes e devolve chaves do mesmo titular', () => {
  const keys = [
    { id: 'root-a', name: 'Ana' },
    { id: 'child-a', parentId: 'root-a', name: 'Dev' },
    { id: 'root-b', name: 'Bruno' },
  ];
  assert.equal(findUserFamily(keys, 'root-a').family.length, 2);
  assert.equal(findUserFamily(keys, 'root-b').family.length, 1);
  assert.equal(findUserFamily(keys, 'child-a'), null);
  assert.equal(findUserFamily(keys, 'inexistente'), null);
});

test('validadores de usuário exigem plano conhecido, booleanos e titular desbloqueado', () => {
  const plans = [{ id: 'payg-usd', name: 'PAYG USD', kind: 'payg', currency: 'USD', active: true, models: [] }];
  const family = [{ id: 'root-a', name: 'Ana', active: true }, { id: 'child-a', parentId: 'root-a', name: 'Dev', active: true }];

  assert.match(validateUserPlan({}, plans, family), /Informe um plano/);
  assert.match(validateUserPlan({ planId: 'inexistente' }, plans, family), /Plano não encontrado/);
  assert.equal(validateUserPlan({ planId: null }, plans, family), null);
  assert.equal(validateUserPlan({ planId: 'payg-usd' }, plans, family), null);

  assert.match(validateUserActive({}), /bloqueado ou desbloqueado/);
  assert.equal(validateUserActive({ active: false }), null);
  assert.equal(validateUserActive({ active: true }), null);

  assert.match(validateUserKeyCreate({ name: '', planId: null }, family, plans), /nome/);
  assert.match(validateUserKeyCreate({ name: 'Dev', planId: 'inexistente' }, family, plans), /Plano não encontrado/);
  assert.equal(validateUserKeyCreate({ name: ' Dev ', planId: 'payg-usd' }, family, plans), null);

  const blocked = family.map(key => ({ ...key, active: false }));
  assert.match(validateUserKeyCreate({ name: 'Dev', planId: null }, blocked, plans), /bloqueado/);
  const full = Array.from({ length: MAX_KEYS_PER_OWNER }, (_, index) => ({ id: `key-${index}`, parentId: index ? 'root-a' : undefined, active: true }));
  assert.match(validateUserKeyCreate({ name: 'Dev', planId: null }, full, plans), /Limite/);
});

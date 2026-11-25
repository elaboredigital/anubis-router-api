import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTopup, validateTopup, buildWallets, checkWalletBalance } from '../src/topup.js';

const key = { id: 'k1', name: 'Claude Code', active: true, planId: 'p1' };
const plan = { id: 'p1', name: 'PAYG 5×', kind: 'payg', currency: 'USD', active: true, models: ['m'] };
const topup = (overrides = {}) => ({ id: 't1', keyId: 'k1', planId: 'p1', amount: '10', currency: 'USD', note: '', idempotencyKey: 'idem-1', createdAt: '2026-11-24T10:00:00.000Z', ...overrides });
const entry = (overrides = {}) => ({ id: 'led-r1', requestId: 'r1', keyId: 'k1', planId: 'p1', status: 'settled', sale: '0.1', saleCurrency: 'USD', ...overrides });

test('normalizeTopup preserva o valor decimal como texto e higieniza os demais campos', () => {
  assert.deepEqual(normalizeTopup({ keyId: ' k1 ', amount: ' 10.50 ', currency: ' usd ', note: '  recarga  ', idempotencyKey: 'idem-1' }), {
    keyId: 'k1', amount: '10.50', currency: 'USD', note: 'recarga', idempotencyKey: 'idem-1',
  });
  assert.deepEqual(normalizeTopup({}), { keyId: '', amount: '', currency: '', note: '', idempotencyKey: null });
  assert.equal(normalizeTopup({ note: 'x'.repeat(500) }).note.length, 160);
});

test('validateTopup aceita qualquer chave ativa e fixa a moeda apenas em planos PAYG', () => {
  const clean = normalizeTopup({ keyId: 'k1', amount: '10', currency: 'USD' });
  assert.equal(validateTopup(clean, key, plan), null);
  assert.match(validateTopup(clean, null, plan), /chave/i);
  assert.match(validateTopup(clean, { ...key, active: false }, plan), /chave/i);
  assert.equal(validateTopup(clean, key, { ...plan, kind: 'free' }), null);
  assert.equal(validateTopup(clean, { ...key, planId: null }, null), null);
  assert.match(validateTopup(clean, key, { ...plan, active: false }), /inativo/i);
  assert.match(validateTopup({ ...clean, currency: 'BRL' }, key, plan), /moeda/i);
  assert.match(validateTopup({ ...clean, currency: '' }, { ...key, planId: null }, null), /moeda/i);
  assert.match(validateTopup({ ...clean, amount: '0' }, key, plan), /valor/i);
  assert.match(validateTopup({ ...clean, amount: 10 }, key, plan), /valor/i);
  assert.match(validateTopup({ ...clean, note: 'x'.repeat(161) }, key, plan), /observação/i);
  assert.match(validateTopup({ ...clean, idempotencyKey: 'chave inválida!' }, key, plan), /idempotência/i);
});

test('buildWallets deduz vendas liquidadas da razão e ignora pendências e outras moedas', () => {
  const wallets = buildWallets(
    [key, { id: 'k2', name: 'Outra', active: true, planId: 'p1' }],
    [plan],
    [topup(), topup({ id: 'dup', amount: '999', idempotencyKey: 'idem-1' }), topup({ id: 't2', keyId: 'k2', amount: '5', idempotencyKey: 'idem-2' })],
    [
      entry(),
      entry({ id: 'led-r2', requestId: 'r2', sale: '0.2', saleCurrency: 'BRL' }),
      entry({ id: 'led-r3', requestId: 'r3', status: 'pending_conversion', sale: null, saleCurrency: 'EUR' }),
      entry({ id: 'led-r4', requestId: 'r4', keyId: 'k2', sale: '1', saleCurrency: 'USD' }),
      entry({ id: 'led-r5', requestId: 'r5', status: 'upstream_error', sale: '99' }),
    ],
  );
  assert.equal(wallets.length, 2);
  const first = wallets.find(item => item.keyId === 'k1');
  assert.equal(first.planId, 'p1');
  assert.equal(first.currency, 'USD');
  assert.equal(first.credits, '10');
  assert.equal(first.consumed, '0.1');
  assert.equal(first.balance, '9.9');
  assert.equal(first.requests, 1);
  assert.equal(first.pending, 2);
  assert.equal(first.negative, false);
  assert.equal(wallets.find(item => item.keyId === 'k2').balance, '4');
});

test('buildWallets mostra PAYG sem recarga e cria carteira avulsa só quando há crédito', () => {
  const freePlan = { id: 'p2', kind: 'free', name: 'Gratuito' };
  const freeKey = { id: 'k3', name: 'Sem PAYG', active: true, planId: 'p2' };
  const noPlanKey = { id: 'k4', name: 'Sem plano', active: true, planId: null };
  const unusedKey = { id: 'k5', name: 'Sem crédito', active: true, planId: 'p2' };
  const wallets = buildWallets(
    [key, freeKey, noPlanKey, unusedKey],
    [plan, freePlan],
    [
      topup({ id: 't3', keyId: 'k3', planId: 'p2', amount: '7', currency: 'BRL', idempotencyKey: 'idem-3' }),
      topup({ id: 't4', keyId: 'k4', planId: null, amount: '3', currency: 'EUR', idempotencyKey: 'idem-4' }),
    ],
    [],
  );
  assert.equal(wallets.some(item => item.keyId === 'k5'), false);
  const payg = wallets.find(item => item.keyId === 'k1');
  assert.equal(payg.balance, '0');
  assert.equal(payg.requests, 0);
  const avulso = wallets.find(item => item.keyId === 'k3');
  assert.equal(avulso.currency, 'BRL');
  assert.equal(avulso.planId, 'p2');
  assert.equal(avulso.planName, 'Gratuito');
  assert.equal(avulso.balance, '7');
  const semPlano = wallets.find(item => item.keyId === 'k4');
  assert.equal(semPlano.planId, null);
  assert.equal(semPlano.planName, 'Recarga avulsa');
  assert.equal(semPlano.balance, '3');
});

test('buildWallets deduce vendas liquidadas da carteira avulsa na mesma moeda', () => {
  const freeKey = { id: 'k3', name: 'Sem PAYG', active: true, planId: 'p2' };
  const wallets = buildWallets(
    [freeKey],
    [],
    [topup({ id: 't3', keyId: 'k3', planId: null, amount: '7', currency: 'BRL', idempotencyKey: 'idem-3' })],
    [entry({ id: 'led-avulso', requestId: 'r-avulso', keyId: 'k3', planId: null, sale: '2', saleCurrency: 'BRL' })],
  );
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].balance, '5');
  assert.equal(wallets[0].consumed, '2');
  assert.equal(wallets[0].requests, 1);
});

test('checkWalletBalance bloqueia saldo insuficiente, moeda divergente e preço indisponível', () => {
  const wallet = buildWallets([key], [plan], [topup()], [])[0];
  const quote = units => ({ currency: 'USD', costCurrency: 'USD', units, estimated: false });
  assert.deepEqual(checkWalletBalance(wallet, quote(BigInt('100000000000'))), { allowed: true, reason: null, balance: '10', required: '0.1', currency: 'USD' });
  assert.equal(checkWalletBalance(wallet, quote(BigInt('10000000000001'))).reason, 'insufficient_balance');
  assert.equal(checkWalletBalance(wallet, { ...quote(BigInt('100000000000')), currency: 'BRL' }).reason, 'currency_pending');
  assert.equal(checkWalletBalance(wallet, quote(null)).reason, 'unpriced');
  assert.equal(checkWalletBalance(null, quote(BigInt('0'))).reason, 'no_wallet');
  assert.equal(checkWalletBalance(wallet, quote(BigInt('0'))).allowed, true);
  assert.equal(checkWalletBalance(buildWallets([key], [plan], [], [])[0], { ...quote(BigInt('0')), estimated: true }).reason, 'insufficient_balance');
});

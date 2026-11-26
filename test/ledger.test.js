import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePrices, quoteSale, buildLedgerEntry, upsertLedgerEntry, summarizeLedger } from '../src/ledger.js';

const at = '2026-11-24T10:30:00.000Z';
const history = [
  { id: 'v0', scope: 'default', multiplier: '5', effectiveAt: null },
  { id: 'v1', scope: 'default', multiplier: '3', effectiveAt: '2026-11-01T00:00:00.000Z' },
  { id: 'vm', scope: 'model', provider: 'xkiro', model: 'remote/m', multiplier: '2', effectiveAt: '2026-11-10T00:00:00.000Z' },
  { id: 'vman', scope: 'manual', provider: 'xkiro', model: 'remote/m', price: { currency: 'USD', basis: 'per_request', request: '0.5' }, effectiveAt: '2026-11-12T00:00:00.000Z' },
  { id: 'vfuture', scope: 'default', multiplier: '9', effectiveAt: '2026-12-01T00:00:00.000Z' },
];

const record = (overrides = {}) => ({
  id: 'a1', requestId: 'r1', attempt: 1, status: 'completed', startedAt: at, finishedAt: at,
  clientKeyId: 'k1', provider: 'xkiro', connectionId: 'c1', publicModel: 'anubis/m', upstreamModel: 'remote/m',
  usage: { inputTokens: 1000, outputTokens: 500 },
  costSnapshot: { billingType: 'token', currency: 'USD', input: '1', output: '2' },
  saleSnapshot: { multiplier: '5', manualPrice: null, versionIds: ['v0'] },
  ...overrides,
});

test('resolvePrices fixa apenas as versões vigentes na data da chamada', () => {
  assert.deepEqual(resolvePrices(history, at, 'xkiro', 'remote/m'), {
    multiplier: '2', manualPrice: { currency: 'USD', basis: 'per_request', request: '0.5' }, versionIds: ['v1', 'vm', 'vman'],
  });
  assert.deepEqual(resolvePrices(history, '2026-11-05T00:00:00.000Z', 'xkiro', 'remote/m'), {
    multiplier: '3', manualPrice: null, versionIds: ['v1'],
  });
  assert.deepEqual(resolvePrices(history, at, 'xkiro', 'outro/m'), {
    multiplier: '3', manualPrice: null, versionIds: ['v1'],
  });
  const removed = [...history, { id: 'vdel', scope: 'manual', provider: 'xkiro', model: 'remote/m', price: null, effectiveAt: '2026-11-20T00:00:00.000Z' }];
  assert.equal(resolvePrices(removed, at, 'xkiro', 'remote/m').manualPrice, null);
  assert.equal(resolvePrices(removed, at, 'xkiro', 'remote/m').versionIds.includes('vdel'), true);
  assert.deepEqual(resolvePrices([], at, 'xkiro', 'remote/m'), { multiplier: '5', manualPrice: null, versionIds: [] });
  const withPlan = [...history, { id: 'vp', scope: 'plan', planId: 'plano-1', multiplier: '3', effectiveAt: '2026-11-15T00:00:00.000Z' }];
  assert.deepEqual(resolvePrices(withPlan, at, 'xkiro', 'remote/m', 'plano-1'), { multiplier: '3', manualPrice: { currency: 'USD', basis: 'per_request', request: '0.5' }, versionIds: ['v1', 'vp', 'vm', 'vman'] });
});

test('quoteSale fixa venda exata por requisição e marca estimativa por token', () => {
  const exact = quoteSale({ billingType: 'request', currency: 'USD', request: '0.02' }, { multiplier: '5' });
  assert.equal(exact.currency, 'USD'); assert.equal(exact.costCurrency, 'USD');
  assert.equal(exact.multiplier, '5'); assert.equal(exact.manual, false); assert.equal(exact.estimated, false);
  assert.equal(exact.units, BigInt('100000000000'));
  const estimated = quoteSale({ billingType: 'token', currency: 'USD', input: '1', output: '2' }, { multiplier: '5' }, { inputTokens: 1000, outputTokens: 500 });
  assert.equal(estimated.estimated, true); assert.equal(estimated.units, BigInt('10000000000'));
  const manual = quoteSale({ billingType: 'token', currency: 'USD', input: '1', output: '2' }, { manualPrice: { currency: 'USD', basis: 'per_request', request: '0.5' }, multiplier: '5' });
  assert.equal(manual.estimated, false); assert.equal(manual.manual, true); assert.equal(manual.units, BigInt('500000000000'));
  assert.equal(quoteSale(null, { multiplier: '5' }), null);
  assert.equal(quoteSale({ billingType: 'request', currency: 'USD', request: '0.02' }, {}).units, null);
});

test('buildLedgerEntry converte custo e venda em unidades exatas e registra as versões usadas', () => {
  const entry = buildLedgerEntry(record(), 'plano-1');
  assert.equal(entry.id, 'led-r1');
  assert.equal(entry.requestId, 'r1');
  assert.equal(entry.keyId, 'k1');
  assert.equal(entry.planId, 'plano-1');
  assert.equal(entry.model, 'remote/m');
  assert.equal(entry.currency, 'USD');
  assert.equal(entry.cost, '0.002');
  assert.equal(entry.sale, '0.01');
  assert.equal(entry.margin, '0.008');
  assert.equal(entry.marginPercent, 80);
  assert.equal(entry.multiplier, '5');
  assert.deepEqual(entry.versionIds, ['v0']);
  assert.equal(buildLedgerEntry(record({ status: 'upstream_error' })), null);
  assert.equal(buildLedgerEntry(record({ costSnapshot: null })), null);
  assert.equal(buildLedgerEntry(record({ saleSnapshot: null })), null);
});

test('buildLedgerEntry usa preço manual de venda com cache e sinaliza moeda sem conversão', () => {
  const manualPrice = { currency: 'USD', basis: 'per_1m_tokens', input: '3', output: '4', cacheRead: '0.5', cacheWrite: '0.6' };
  const entry = buildLedgerEntry(record({
    usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, cacheWriteTokens: 100 },
    saleSnapshot: { multiplier: '5', manualPrice, versionIds: ['vman'] },
  }));
  assert.equal(entry.cost, '0.002');
  assert.equal(entry.sale, '0.00456');
  assert.equal(entry.multiplier, null);
  assert.equal(entry.status, 'settled');
  const mismatch = buildLedgerEntry(record({
    costSnapshot: { billingType: 'request', currency: 'BRL', request: '0.1' },
    saleSnapshot: { multiplier: '5', manualPrice: { currency: 'USD', basis: 'per_request', request: '0.5' }, versionIds: ['vman'] },
  }));
  assert.equal(mismatch.status, 'pending_conversion');
  assert.equal(mismatch.sale, null);
  assert.equal(mismatch.cost, '0.1');
});

test('upsertLedgerEntry não duplica a mesma requisição', () => {
  const first = buildLedgerEntry(record(), 'plano-1');
  const changed = buildLedgerEntry(record({ saleSnapshot: { multiplier: '9', manualPrice: null, versionIds: ['v0'] } }), 'plano-1');
  const entries = upsertLedgerEntry([], first);
  assert.equal(entries.length, 1);
  assert.equal(upsertLedgerEntry(entries, changed)[0].sale, '0.018');
  assert.equal(upsertLedgerEntry(entries, changed).length, 1);
});

test('summarizeLedger separa moedas e conta pendências sem inventar valor', () => {
  const first = buildLedgerEntry(record(), 'plano-1');
  const brlSnapshot = { billingType: 'request', currency: 'BRL', request: '0.1' };
  const second = buildLedgerEntry(record({ id: 'a2', requestId: 'r2', clientKeyId: 'k2', costSnapshot: brlSnapshot }), 'plano-2');
  const pending = buildLedgerEntry(record({ id: 'a3', requestId: 'r3', costSnapshot: brlSnapshot, saleSnapshot: { multiplier: '5', manualPrice: { currency: 'USD', basis: 'per_request', request: '1' }, versionIds: ['vman'] } }), 'plano-1');
  const recordsList = [
    record(), record({ id: 'a2', requestId: 'r2', clientKeyId: 'k2', costSnapshot: brlSnapshot }),
    record({ id: 'a3', requestId: 'r3', costSnapshot: brlSnapshot }),
    record({ id: 'a4', requestId: 'r4', status: 'upstream_error' }),
    record({ id: 'a5', requestId: 'r5', costSnapshot: null }),
  ];
  const summary = summarizeLedger([first, second, pending], recordsList);
  const usd = summary.totals.find(item => item.currency === 'USD');
  const brl = summary.totals.find(item => item.currency === 'BRL');
  assert.equal(usd.cost, '0.002'); assert.equal(usd.sale, '0.01'); assert.equal(usd.marginPercent, 80);
  assert.equal(brl.cost, '0.2'); assert.equal(brl.sale, '0.5'); assert.equal(brl.entries, 2);
  assert.deepEqual(summary.counts, { completed: 4, entries: 3, unpriced: 1, pendingConversion: 1 });
  assert.equal(summary.byPlan.find(item => item.name === 'plano-2' && item.currency === 'BRL').sale, '0.5');
  assert.equal(summary.byKey.find(item => item.name === 'k1' && item.currency === 'USD').cost, '0.002');
});

test('venda usa o custo médio fixado e mantém o custo real da rota usada', () => {
  const quote = quoteSale(
    { billingType: 'token', currency: 'USD', input: '1', output: '1' },
    { multiplier: '5', referenceCost: { billingType: 'token', currency: 'USD', input: '2', output: '2' } },
    { inputTokens: 1_000_000, outputTokens: 0 },
  );
  assert.equal(quote.costUnits, 1_000_000_000_000n);
  assert.equal(quote.units, 10_000_000_000_000n);
});

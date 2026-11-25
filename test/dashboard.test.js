import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, buildKeyUsage, decimalUnits, formatUnits, recordCost } from '../src/dashboard.js';

test('estima saldo por requisição sem confundir uso desconhecido, moedas ou planos', () => {
  assert.equal(formatUnits(decimalUnits('0.0025') + decimalUnits('0.000000001')), '0.002500001');
  assert.equal(decimalUnits('-1'), null);
  const connections = [{ id: 'a', provider: 'wusrouter', name: 'Principal', active: true }, { id: 'b', provider: 'wusrouter', name: 'Outra', active: true }];
  const accounts = [{ connectionId: 'a', balance: '10', currency: 'USD', billingMode: 'payg', balanceAsOf: '2026-01-01T00:00:00.000Z' }, { connectionId: 'b', balance: '5', currency: 'USD', billingMode: 'subscription', balanceAsOf: '2026-01-01T00:00:00.000Z' }];
  const records = [
    { connectionId: 'a', startedAt: '2026-01-02T00:00:00.000Z', status: 'completed', costSnapshot: { billingType: 'request', request: '0.02', currency: 'USD' } },
    { connectionId: 'a', startedAt: '2026-01-02T00:00:01.000Z', status: 'completed', costSnapshot: { billingType: 'token', currency: 'USD' } },
    { connectionId: 'a', startedAt: '2026-01-02T00:00:02.000Z', status: 'cancelled', costSnapshot: { billingType: 'request', request: '0.02', currency: 'USD' } },
    { connectionId: 'a', startedAt: '2025-12-31T00:00:00.000Z', status: 'completed', costSnapshot: { billingType: 'request', request: '100', currency: 'USD' } },
    { connectionId: 'b', startedAt: '2026-01-02T00:00:00.000Z', status: 'completed', costSnapshot: { billingType: 'request', request: '1', currency: 'USD' } },
  ];
  const result = buildDashboard(connections, accounts, records);
  assert.equal(result[0].estimatedSpend, '0.02'); assert.equal(result[0].estimatedBalance, '9.98'); assert.equal(result[0].unpricedRequests, 2);
  assert.equal(result[1].estimatedSpend, null); assert.equal(result[1].estimatedBalance, null);
});

test('buildKeyUsage apura tokens e gasto por chave sem misturar moedas nem cobrar falhas', () => {
  const keys = [{ id: 'k1', name: 'Um' }, { id: 'k2', name: 'Dois' }];
  const records = [
    { clientKeyId: 'k1', status: 'completed', costSnapshot: { billingType: 'request', currency: 'USD', request: '0.02' }, usage: { inputTokens: 100, outputTokens: 12 } },
    { clientKeyId: 'k1', status: 'completed', costSnapshot: { billingType: 'token', currency: 'USD', input: '1', output: '2', cacheRead: '0.1', cacheWrite: '0.5' }, usage: { inputTokens: 1000000, outputTokens: 500000, cachedInputTokens: 400000, cacheWriteTokens: 100000 } },
    { clientKeyId: 'k1', status: 'completed', costSnapshot: { billingType: 'token', currency: 'BRL', input: '3', output: '4' }, usage: { inputTokens: 1000000 } },
    { clientKeyId: 'k1', status: 'upstream_error', costSnapshot: { billingType: 'request', currency: 'USD', request: '100' }, usage: { outputTokens: 5000000 } },
    { clientKeyId: 'k2', status: 'completed', costSnapshot: null, usage: {} },
  ];
  const result = buildKeyUsage(keys, records);

  assert.deepEqual(result[0], {
    keyId: 'k1', requests: 3, inputTokens: 2000100, outputTokens: 500012, cachedInputTokens: 400000, cacheWriteTokens: 100000,
    spend: [{ currency: 'BRL', amount: '3' }, { currency: 'USD', amount: '1.71' }], unpricedRequests: 0,
  });
  assert.deepEqual(result[1], {
    keyId: 'k2', requests: 1, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
    spend: [], unpricedRequests: 1,
  });
});

test('recordCost aplica desconto de leitura e acrescimo de gravacao de cache quando ha preco', () => {
  const base = { status: 'completed', costSnapshot: { billingType: 'token', currency: 'USD', input: '1', output: '2' }, usage: { inputTokens: 1000000, outputTokens: 500000, cachedInputTokens: 400000, cacheWriteTokens: 100000 } };
  assert.equal(formatUnits(recordCost(base).units), '2');
  const read = { ...base, costSnapshot: { ...base.costSnapshot, cacheRead: '0.1' } };
  assert.equal(formatUnits(recordCost(read).units), '1.64');
  const both = { ...base, costSnapshot: { ...base.costSnapshot, cacheRead: '0.1', cacheWrite: '0.5' } };
  assert.equal(formatUnits(recordCost(both).units), '1.69');
});

test('buildDashboard expõe a franquia diária do fornecedor e o backup', () => {
  const day = { start: '2026-01-02T00:00:00.000Z', end: '2026-01-03T00:00:00.000Z' };
  const connections = [{ id: 'a', provider: 'xkiro', name: 'Conta', active: true }];
  const accounts = [{ connectionId: 'a', balance: '10', currency: 'USD', billingMode: 'payg', dailyTokens: 500000, backup: true }];
  const records = [
    { connectionId: 'a', status: 'completed', startedAt: '2026-01-02T10:00:00.000Z', usage: { inputTokens: 600, outputTokens: 100 } },
    { connectionId: 'a', status: 'cancelled', startedAt: '2026-01-02T11:00:00.000Z', usage: { inputTokens: 300 } },
    { connectionId: 'a', status: 'completed', startedAt: '2026-01-01T10:00:00.000Z', usage: { inputTokens: 999 } },
  ];
  const [item] = buildDashboard(connections, accounts, records, day);
  assert.deepEqual(item.dailyUsage, { tokens: 1000, limit: 500000, remaining: 499000, backup: true });
  const [unlimited] = buildDashboard(connections, [{ connectionId: 'a' }], records, day);
  assert.equal(unlimited.dailyUsage, null);
});

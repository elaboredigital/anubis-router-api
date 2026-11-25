import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClientHome } from '../src/client-home.js';

const NOW = '2026-11-24T12:00:00.000Z';
const key = { id: 'k1', name: 'Alan Diniz', prefix: 'sk-anubis-1234', active: true, createdAt: '2026-10-01T00:00:00.000Z', planId: 'p1', hash: 'hash-secreto', secret: 'segredo-nunca-sair' };
const plan = { id: 'p1', name: 'PAYG 5×', kind: 'payg', currency: 'USD', active: true, monthlyRequests: 100, monthlyTokens: 1000, models: ['anubis/mistral', 'anubis/devstral'] };
const record = (overrides = {}) => ({
  id: 'r1', requestId: 'req-1', attempt: 1, clientKeyId: 'k1', planId: 'p1', startedAt: '2026-11-22T10:00:00.000Z',
  status: 'completed', publicModel: 'anubis/mistral', usage: { inputTokens: 100, outputTokens: 50 },
  costSnapshot: { currency: 'USD', request: '1.4' }, saleSnapshot: { multiplier: '5', versionIds: [] }, prompt: 'prompt privado',
  ...overrides,
});
const entry = (overrides = {}) => ({
  id: 'led-1', requestId: 'req-1', keyId: 'k1', planId: 'p1', status: 'settled', sale: '7', saleCurrency: 'USD',
  currency: 'USD', cost: '1.4', publicModel: 'anubis/mistral', startedAt: '2026-11-22T10:00:00.000Z',
  ...overrides,
});

const input = () => ({
  key, plan, plans: [plan],
  records: [
    record({ id: 'r-pending', requestId: 'req-4', status: 'pending', startedAt: '2026-11-23T11:00:00.000Z', costSnapshot: null, saleSnapshot: null }),
    record({ id: 'r-failed', requestId: 'req-3', status: 'upstream_error', startedAt: '2026-11-23T10:00:00.000Z', costSnapshot: null, saleSnapshot: null }),
    record(),
    record({ id: 'r-retry', requestId: 'req-1', attempt: 2 }),
    record({ id: 'r-2', requestId: 'req-2', startedAt: '2026-11-02T10:00:00.000Z', publicModel: 'anubis/devstral', usage: { inputTokens: 200, outputTokens: 80 } }),
    record({ id: 'r-other', requestId: 'req-other', clientKeyId: 'k2', startedAt: '2026-11-23T09:00:00.000Z', publicModel: 'outro/modelo' }),
  ],
  entries: [
    entry(),
    entry({ id: 'led-2', requestId: 'req-2', sale: '3', publicModel: 'anubis/devstral', startedAt: '2026-11-02T10:00:00.000Z' }),
    entry({ id: 'led-pending', requestId: 'req-pending', status: 'pending_conversion', sale: null, startedAt: '2026-11-20T10:00:00.000Z' }),
    entry({ id: 'led-other', requestId: 'req-other', keyId: 'k2', sale: '99' }),
  ],
  topups: [{ id: 't1', keyId: 'k1', amount: '10', currency: 'USD' }],
  now: NOW,
});

test('buildClientHome resume apenas a chave informada, sem segredos nem valores inferidos', () => {
  const report = buildClientHome(input());
  assert.equal(report.account.label, 'sk-anubis-1234••••••••');
  assert.deepEqual(report.activity, { requests30: 2, tokens30: 430, requests7: 1, tokens7: 150 });
  assert.deepEqual(report.spend.last30, [{ currency: 'USD', amount: '10' }]);
  assert.deepEqual(report.spend.last7, [{ currency: 'USD', amount: '7' }]);
  assert.deepEqual(report.spend.avgDaily7, [{ currency: 'USD', amount: '1' }]);
  assert.deepEqual(report.spend.paygTotal, [{ currency: 'USD', amount: '10' }]);
  assert.equal(report.spend.since, '2026-11-02T10:00:00.000Z');
  assert.equal(report.wallet.currency, 'USD');
  assert.equal(report.wallet.balance, '0');
  assert.equal(report.plan.percentTokens, 43);
  assert.equal(report.plan.daysToReset, 7);
  assert.deepEqual(report.topModels, [
    { model: 'anubis/mistral', currency: 'USD', amount: '7' },
    { model: 'anubis/devstral', currency: 'USD', amount: '3' },
  ]);
  assert.equal(report.recent.length, 4);
  assert.equal(report.recent[0].status, 'pending');
  assert.equal(report.recent[1].status, 'failed');
  assert.equal(report.recent[2].amount, '7');
  assert.equal(report.recent.some(item => item.model === 'outro/modelo'), false);
  const text = JSON.stringify(report);
  for (const secret of ['hash-secreto', 'segredo-nunca-sair', 'prompt privado', 'sk-anubis-1234"']) assert.equal(text.includes(secret), false);
});

test('buildClientHome mostra a cota diária e conta cancelamentos do dia', () => {
  const data = input();
  const free = { id: 'p2', name: 'Gratuito', kind: 'free', active: true, models: [], monthlyRequests: null, monthlyTokens: null, dailyRequests: null, dailyTokens: 500000 };
  const records = [
    record({ id: 'r-today', requestId: 'req-today', planId: 'p2', startedAt: '2026-11-24T10:00:00.000Z', usage: { inputTokens: 600, outputTokens: 100 } }),
    record({ id: 'r-cancel', requestId: 'req-cancel', planId: 'p2', status: 'cancelled', startedAt: '2026-11-24T09:00:00.000Z', usage: { inputTokens: 250 } }),
    record({ id: 'r-old', requestId: 'req-old', planId: 'p2', startedAt: '2026-11-20T10:00:00.000Z', usage: { inputTokens: 900, outputTokens: 100 } }),
  ];
  const report = buildClientHome({ ...data, key: { ...key, planId: 'p2' }, plan: free, plans: [free], records, entries: [], topups: [] });
  assert.equal(report.plan.dailyTokensUsed, 950);
  assert.equal(report.plan.dailyTokensLimit, 500000);
  assert.equal(report.plan.percentDailyTokens, 0);
  assert.equal(report.plan.resetAt, '2026-11-25T00:00:00.000Z');
  assert.equal(report.plan.hoursToReset, 12);
  assert.equal(report.plan.allowed, true);
});

test('buildClientHome mantém limites vazios sem percentual e não cria carteira sem dados', () => {
  const data = input();
  const free = { id: 'p2', name: 'Gratuito', kind: 'free', active: true, models: [], monthlyRequests: null, monthlyTokens: null };
  const report = buildClientHome({ ...data, key: { ...key, planId: 'p2' }, plan: free, plans: [free], topups: [], entries: [] });
  assert.equal(report.plan.percentRequests, null);
  assert.equal(report.plan.percentTokens, null);
  assert.equal(report.plan.allowed, true);
  assert.equal(report.wallet, null);
  assert.deepEqual(report.spend.last30, []);
  assert.deepEqual(report.recent.filter(item => item.status === 'settled'), []);
  assert.equal(buildClientHome({ ...data, key: null }), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobalStats } from '../src/global-stats.js';

const NOW = '2026-11-24T12:00:00.000Z';
const PERIOD = { from: '2026-11-22T00:00:00.000Z', to: '2026-11-25T00:00:00.000Z' };
const keys = [
  { id: 'k1', name: 'Alan', prefix: 'anubis_alan_', active: true, planId: 'p1', hash: 'hash-secreto' },
  { id: 'k2', name: 'Outro', prefix: 'anubis_outro_', active: false, planId: null, secret: 'segredo' },
];
const plans = [{ id: 'p1', name: 'Pro', kind: 'paid', active: true }];
const record = (overrides = {}) => ({
  requestId: 'req-1', attempt: 1, clientKeyId: 'k1', startedAt: '2026-11-22T10:00:00.000Z',
  status: 'completed', publicModel: 'anubis/mistral', provider: 'xkiro', connectionId: 'c1',
  usage: { inputTokens: 100, outputTokens: 50 },
  costSnapshot: { billingType: 'request', currency: 'USD', request: '1.4' }, prompt: 'prompt privado', ...overrides,
});
const entry = (overrides = {}) => ({
  id: 'led-1', requestId: 'req-1', keyId: 'k1', status: 'settled', sale: '7',
  saleCurrency: 'USD', currency: 'USD', response: 'resposta privada', ...overrides,
});
const input = () => ({
  keys, plans, now: NOW, period: PERIOD,
  records: [
    record(),
    record({ requestId: 'req-1', attempt: 2, startedAt: '2026-11-22T10:05:00.000Z', status: 'cancelled' }),
    record({ requestId: 'req-2', clientKeyId: 'k2', startedAt: '2026-11-23T11:00:00.000Z', status: 'upstream_error', costSnapshot: null }),
    record({ requestId: 'req-3', clientKeyId: 'k2', startedAt: '2026-11-23T12:00:00.000Z', status: 'pending', costSnapshot: null }),
    record({ requestId: 'req-4', startedAt: '2026-11-24T09:00:00.000Z', publicModel: 'anubis/devstral', provider: 'notholy', connectionId: 'c2', usage: { inputTokens: 200, outputTokens: 80 }, costSnapshot: null }),
    record({ requestId: 'req-old', startedAt: '2026-11-21T09:00:00.000Z' }),
  ],
  entries: [
    entry(),
    entry({ id: 'led-eur', requestId: 'req-4', sale: '3', saleCurrency: 'EUR', currency: 'EUR', cost: '0.4' }),
    entry({ id: 'led-pending', requestId: 'req-2', keyId: 'k2', status: 'pending_conversion', sale: null }),
  ],
  topups: [{ id: 't1', keyId: 'k1', amount: '10', currency: 'USD' }],
  connections: [{ id: 'c1', name: 'xKiro principal', provider: 'xkiro', active: true, apiKey: 'segredo-fornecedor' }],
});

test('buildGlobalStats unifica chaves, status, custo e venda sem converter moedas', () => {
  const report = buildGlobalStats(input());
  assert.deepEqual(report.period, { from: PERIOD.from, to: PERIOD.to, clamped: false });
  assert.deepEqual(report.byStatus, { completed: 2, failed: 1, cancelled: 0, pending: 1 });
  assert.equal(report.totals.observed, 4);
  assert.equal(report.totals.requests, 2);
  assert.equal(report.totals.tokens, 430);
  assert.deepEqual(report.totals.spend, [{ currency: 'EUR', amount: '3' }, { currency: 'USD', amount: '7' }]);
  assert.deepEqual(report.totals.cost, [{ currency: 'USD', amount: '1.4' }]);
  assert.equal(report.totals.unpriced, 0);
  assert.deepEqual(report.keys.active, 1);
  assert.equal(report.keys.revoked, 1);
  assert.equal(report.keys.withPlan, 1);
  assert.equal(report.keys.top[0].label, 'anubis_alan_••••••••');
  assert.equal(report.keys.top[0].requests, 2);
  assert.equal(report.plans[0].keys, 1);
  assert.equal(report.connections.active, 1);
  assert.deepEqual(report.connections.byProvider.map(item => item.id), ['notholy', 'xkiro']);
  assert.deepEqual(report.models.map(item => item.id), ['anubis/devstral', 'anubis/mistral']);
  assert.deepEqual(report.wallets.byCurrency, [{ currency: 'USD', keys: 1, credits: '10', consumed: '7', balance: '3' }]);
  assert.equal(report.series.length, 3);
  assert.equal(report.series.find(day => day.date === '2026-11-22').completed, 1);
  assert.equal(report.series.find(day => day.date === '2026-11-22').cancelled, 0);
});

test('buildGlobalStats nao expoe chave completa, hash, prompt, resposta ou segredo', () => {
  const text = JSON.stringify(buildGlobalStats(input()));
  for (const needle of ['hash-secreto', 'segredo', 'prompt privado', 'resposta privada', 'apiKey', 'anubis_alan_secret']) {
    assert.equal(text.includes(needle), false, needle);
  }
});

test('buildGlobalStats valida periodo ISO UTC e limita a 366 dias', () => {
  assert.match(buildGlobalStats({ period: { from: '22/11/2026' } }).error, /ISO UTC/);
  assert.match(buildGlobalStats({ period: { from: PERIOD.to, to: PERIOD.from } }).error, /anterior ao fim/);
  const long = buildGlobalStats({ ...input(), period: { from: '2024-01-01T00:00:00.000Z', to: NOW } });
  assert.equal(long.period.clamped, true);
  assert.ok(long.series.length <= 366);
});

test('buildGlobalStats informa admin, usuários, lucro e falhas sem expor segredos', () => {
  const report = buildGlobalStats({
    keys: [
      { id: 'k1', name: 'Ativo', prefix: 'anubis_ativo_', active: true, planId: 'p1' },
      { id: 'k2', name: 'Falho', prefix: 'anubis_falho_', active: true, planId: 'p1' },
    ],
    plans: [{ id: 'p1', name: 'Pro', kind: 'paid', active: true }],
    now: NOW, period: PERIOD,
    records: [
      record({ requestId: 'req-ok', clientKeyId: 'k1', status: 'completed' }),
      record({
        requestId: 'req-fail', clientKeyId: 'k2', status: 'upstream_error', httpStatus: 503,
        costSnapshot: null, failure: { stage: 'http', reason: 'resposta_http', status: 503, retryable: true },
      }),
    ],
    entries: [entry({ requestId: 'req-ok', sale: '10', saleCurrency: 'USD', currency: 'USD', margin: '8' })],
    topups: [{ id: 't1', keyId: 'k1', amount: '20', currency: 'USD' }],
    connections: [{ id: 'c1', name: 'xKiro', provider: 'xkiro', active: true }],
    admin: { configured: true, clientSessions: 2 },
  });

  assert.deepEqual(report.admin, { configured: true, clientSessions: 2 });
  assert.deepEqual(report.users, { total: 2, active: 2, activeInPeriod: 1, withActivityInPeriod: 2 });
  assert.deepEqual(report.totals.profit, [{ currency: 'USD', amount: '8' }]);
  assert.equal(report.failureRate, 50);
  assert.equal(report.failures.attempts, 1);
  assert.equal(report.failures.requests, 1);
  assert.deepEqual(report.failures.byStage, { http: 1 });
  assert.deepEqual(report.failures.byReason, { resposta_http: 1 });
  const failure = report.failures.recent[0];
  assert.equal(failure.requestId, 'req-fail');
  assert.equal(failure.attempt, 1);
  assert.equal(failure.provider, 'xkiro');
  assert.equal(failure.model, 'anubis/mistral');
  assert.equal(failure.httpStatus, 503);
  assert.equal(failure.stage, 'http');
  assert.equal(failure.reason, 'resposta_http');
  assert.equal(failure.retryable, true);
  const text = JSON.stringify(report);
  for (const needle of ['prompt privado', 'resposta privada', 'anubis_ativo_secret', 'hash-secreto']) {
    assert.equal(text.includes(needle), false, needle);
  }
});

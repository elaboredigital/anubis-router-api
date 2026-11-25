import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClientStats } from '../src/client-stats.js';

const NOW = '2026-11-24T12:00:00.000Z';
const PERIOD = { from: '2026-11-22T00:00:00.000Z', to: '2026-11-25T00:00:00.000Z' };
const key = { id: 'k1', name: 'Alan Diniz', prefix: 'anubis_cliente_', hash: 'hash-secreto', secret: 'segredo-nunca-sair' };
const record = (overrides = {}) => ({
  id: 'r-1', requestId: 'req-1', attempt: 1, clientKeyId: 'k1', planId: 'p1',
  startedAt: '2026-11-22T10:00:00.000Z', finishedAt: '2026-11-22T10:00:00.000Z',
  status: 'completed', publicModel: 'anubis/mistral', provider: 'xkiro',
  usage: { inputTokens: 100, outputTokens: 50 },
  costSnapshot: { currency: 'USD', request: '1.4' }, saleSnapshot: { multiplier: '5', versionIds: [] },
  prompt: 'prompt privado', ...overrides,
});
const entry = (overrides = {}) => ({
  id: 'led-1', requestId: 'req-1', keyId: 'k1', planId: 'p1', status: 'settled',
  sale: '7', saleCurrency: 'USD', currency: 'USD', cost: '1.4',
  publicModel: 'anubis/mistral', startedAt: '2026-11-22T10:00:00.000Z', ...overrides,
});

const input = () => ({
  key, now: NOW, period: PERIOD,
  records: [
    record(),
    record({ id: 'r-retry', requestId: 'req-1', attempt: 2, startedAt: '2026-11-22T10:05:00.000Z' }),
    record({ id: 'r-eur', requestId: 'req-7', startedAt: '2026-11-22T15:00:00.000Z', usage: { inputTokens: 60, outputTokens: 40 } }),
    record({ id: 'r-fail', requestId: 'req-2', startedAt: '2026-11-23T11:00:00.000Z', status: 'upstream_error', httpStatus: 502, costSnapshot: null, saleSnapshot: null }),
    record({ id: 'r-cancel', requestId: 'req-3', startedAt: '2026-11-23T12:00:00.000Z', status: 'cancelled' }),
    record({ id: 'r-pending', requestId: 'req-4', startedAt: '2026-11-24T09:00:00.000Z', status: 'pending' }),
    record({ id: 'r-unpriced', requestId: 'req-5', startedAt: '2026-11-24T10:00:00.000Z', publicModel: 'anubis/devstral', provider: 'notholy', usage: { inputTokens: 200, outputTokens: 80 } }),
    record({ id: 'r-old', requestId: 'req-6', startedAt: '2026-11-21T10:00:00.000Z' }),
    record({ id: 'r-other', requestId: 'req-other', clientKeyId: 'k2', startedAt: '2026-11-23T09:00:00.000Z', publicModel: 'outro/modelo' }),
  ],
  entries: [
    entry(),
    entry({ id: 'led-eur', requestId: 'req-7', sale: '3', saleCurrency: 'EUR', currency: 'EUR' }),
    entry({ id: 'led-pending', requestId: 'req-5', status: 'pending_conversion', sale: null, startedAt: '2026-11-24T10:00:00.000Z' }),
    entry({ id: 'led-other', requestId: 'req-other', keyId: 'k2', sale: '99' }),
  ],
});

test('buildClientStats agrega por requisição deduplicada, sem converter moedas nem expor segredos', () => {
  const report = buildClientStats(input());
  assert.deepEqual(report.period, { from: PERIOD.from, to: PERIOD.to, clamped: false });
  assert.deepEqual(report.account, { name: 'Alan Diniz', label: 'anubis_cliente_••••••••' });
  assert.deepEqual(report.totals, {
    requests: 3, tokens: 530, completed: 3, failed: 1, cancelled: 1, pending: 1, unpriced: 1,
    spend: [{ currency: 'EUR', amount: '3' }, { currency: 'USD', amount: '7' }],
  });
  assert.deepEqual(report.byStatus, { completed: 3, failed: 1, cancelled: 1, pending: 1 });
  assert.equal(report.series.length, 3);
  assert.deepEqual(report.series[0], {
    date: '2026-11-22', requests: 2, tokens: 250, completed: 2, failed: 0, cancelled: 0, pending: 0,
    spend: [{ currency: 'EUR', amount: '3' }, { currency: 'USD', amount: '7' }],
  });
  assert.deepEqual(report.series[1], {
    date: '2026-11-23', requests: 0, tokens: 0, completed: 0, failed: 1, cancelled: 1, pending: 0, spend: [],
  });
  assert.deepEqual(report.series[2], {
    date: '2026-11-24', requests: 1, tokens: 280, completed: 1, failed: 0, cancelled: 0, pending: 1, spend: [],
  });
  assert.deepEqual(report.byModel, [
    { model: 'anubis/mistral', requests: 2, tokens: 250, spend: [{ currency: 'EUR', amount: '3' }, { currency: 'USD', amount: '7' }] },
    { model: 'anubis/devstral', requests: 1, tokens: 280, spend: [] },
  ]);
  assert.deepEqual(report.byProvider, [
    { provider: 'xkiro', requests: 2, tokens: 250, spend: [{ currency: 'EUR', amount: '3' }, { currency: 'USD', amount: '7' }] },
    { provider: 'notholy', requests: 1, tokens: 280, spend: [] },
  ]);
  assert.deepEqual(report.requests.map(item => item.requestId).sort(), ['req-1', 'req-2', 'req-3', 'req-4', 'req-5', 'req-7']);
  const retry = report.requests.find(item => item.requestId === 'req-1');
  assert.equal(retry.status, 'completed');
  assert.equal(retry.attempts.length, 2);
  assert.equal(retry.billing.sale, '7');
  assert.equal(retry.billing.currency, 'USD');
  const text = JSON.stringify(report);
  for (const secret of ['hash-secreto', 'segredo-nunca-sair', 'prompt privado', 'outro/modelo', 'req-other']) {
    assert.equal(text.includes(secret), false);
  }
});

test('buildClientStats usa o último desfecho conhecido por requisição e detalha as tentativas sem expor conteúdo', () => {
  const data = input();
  data.records.push(
    record({ id: 'r-mix-cancel', requestId: 'req-mix', attempt: 1, startedAt: '2026-11-24T08:00:00.000Z', finishedAt: '2026-11-24T08:01:00.000Z', status: 'cancelled', httpStatus: 499, prompt: 'prompt secreto' }),
    record({ id: 'r-mix-done', requestId: 'req-mix', attempt: 2, startedAt: '2026-11-24T08:02:00.000Z', finishedAt: '2026-11-24T08:03:00.000Z', status: 'completed', usage: { inputTokens: 10, outputTokens: 5 } }),
  );
  data.entries.push(entry({ id: 'led-mix', requestId: 'req-mix', sale: '2', saleCurrency: 'USD', startedAt: '2026-11-24T08:02:00.000Z' }));
  const report = buildClientStats(data);
  assert.equal(report.totals.requests, 4);
  assert.deepEqual(report.byStatus, { completed: 4, failed: 1, cancelled: 1, pending: 1 });
  const mix = report.requests.find(item => item.requestId === 'req-mix');
  assert.equal(mix.status, 'completed');
  assert.equal(mix.attempts.length, 2);
  assert.deepEqual(mix.attempts.map(item => item.status), ['cancelled', 'completed']);
  assert.equal(mix.attempts[0].httpStatus, 499);
  assert.equal(mix.attempts[1].tokens, 15);
  assert.equal(mix.billing.status, 'settled');
  assert.equal(mix.billing.sale, '2');
  const text = JSON.stringify(report);
  for (const secret of ['prompt secreto', 'hash-secreto', 'segredo-nunca-sair']) assert.equal(text.includes(secret), false);
});

test('buildClientStats usa janela padrão, limita o intervalo e rejeita períodos inválidos', () => {
  const base = { key, records: [], entries: [], now: NOW };
  const report = buildClientStats(base);
  assert.equal(report.period.from, '2026-10-25T12:00:00.000Z');
  assert.equal(report.period.to, NOW);
  assert.equal(report.period.clamped, false);
  assert.equal(report.series.length, 31);

  const clamped = buildClientStats({ ...base, period: { from: '2020-01-01T00:00:00.000Z', to: NOW } });
  assert.equal(clamped.period.clamped, true);
  assert.equal(clamped.period.from, '2025-11-24T12:00:00.000Z');
  assert.equal(clamped.series.length, 366);

  assert.match(buildClientStats({ ...base, period: { from: '2026-11-25T00:00:00.000Z', to: NOW } }).error, /início deve ser anterior/);
  assert.match(buildClientStats({ ...base, period: { from: '24/11/2026', to: null } }).error, /ISO UTC/);
  assert.equal(buildClientStats({ ...base, key: null }), null);
});

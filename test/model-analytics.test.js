import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelAnalytics } from '../src/model-analytics.js';

const NOW = '2026-11-24T12:00:00.000Z';
const PERIOD = { from: '2026-11-22T00:00:00.000Z', to: '2026-11-25T00:00:00.000Z' };
const keys = [
  { id: 'k1', name: 'Alan', prefix: 'anubis_alan_', active: true, planId: 'p1', hash: 'hash-secreto' },
  { id: 'k2', name: 'Bia', prefix: 'anubis_bia_', active: false, planId: null, secret: 'segredo' },
];
const record = (overrides = {}) => ({
  requestId: 'req-1', attempt: 1, clientKeyId: 'k1', startedAt: '2026-11-22T10:00:00.000Z',
  status: 'completed', publicModel: 'anubis/mistral', upstreamModel: 'mistralai/mistral-large',
  provider: 'xkiro', connectionId: 'c1', usage: { inputTokens: 100, outputTokens: 50 },
  costSnapshot: { billingType: 'request', currency: 'USD', request: '1.4' }, prompt: 'prompt privado', ...overrides,
});
const entry = (overrides = {}) => ({
  id: 'led-1', requestId: 'req-1', keyId: 'k1', status: 'settled', sale: '7',
  saleCurrency: 'USD', currency: 'USD', margin: '5.6', response: 'resposta privada', ...overrides,
});
const input = () => ({
  keys, plans: [{ id: 'p1', name: 'Pro', active: true }], now: NOW, period: PERIOD,
  records: [
    record(),
    record({ requestId: 'req-1', attempt: 2, startedAt: '2026-11-22T10:05:00.000Z', status: 'cancelled' }),
    record({ requestId: 'req-2', clientKeyId: 'k2', startedAt: '2026-11-23T11:00:00.000Z', status: 'upstream_error', costSnapshot: null }),
    record({ requestId: 'req-5', clientKeyId: 'k2', startedAt: '2026-11-23T12:00:00.000Z', costSnapshot: { billingType: 'request', currency: 'USD', request: '2' } }),
    record({ requestId: 'req-4', startedAt: '2026-11-24T09:00:00.000Z', publicModel: 'anubis/devstral', upstreamModel: 'mistralai/devstral', provider: 'notholy', connectionId: 'c2', costSnapshot: null }),
    record({ requestId: 'req-old', startedAt: '2026-11-21T09:00:00.000Z' }),
  ],
  entries: [
    entry(),
    entry({ id: 'led-5', requestId: 'req-5', keyId: 'k2', sale: '4', margin: '2' }),
    entry({ id: 'led-eur', requestId: 'req-4', sale: '3', saleCurrency: 'EUR', currency: 'EUR', margin: null }),
    entry({ id: 'led-pending', requestId: 'req-2', keyId: 'k2', status: 'pending_conversion', sale: null }),
  ],
  routes: [{ id: 'anubis/mistral', provider: 'xkiro', connectionId: 'c1', upstreamModel: 'mistralai/mistral-large', enabled: true }],
  connections: [{ id: 'c1', name: 'xKiro principal', provider: 'xkiro', active: true, apiKey: 'segredo-fornecedor' }],
  admin: { configured: true, clientSessions: 2 },
});

test('buildModelAnalytics resume custo, venda, lucro e margem por modelo sem converter moedas', () => {
  const report = buildModelAnalytics(input());
  assert.deepEqual(report.period, { from: PERIOD.from, to: PERIOD.to, clamped: false });
  assert.deepEqual(report.admin, { configured: true, clientSessions: 2, keys: 2, activeKeys: 1 });
  assert.equal(report.scope, 'last_10000_requests');
  assert.deepEqual(report.totals.spend, [{ currency: 'EUR', amount: '3' }, { currency: 'USD', amount: '11' }]);
  assert.deepEqual(report.totals.profit, [{ currency: 'USD', amount: '7.6' }]);
  assert.deepEqual(report.models.map(item => item.model), ['anubis/mistral', 'anubis/devstral']);

  const mistral = report.models[0];
  assert.equal(mistral.requests, 2);
  assert.equal(mistral.observed, 3);
  assert.equal(mistral.keys, 2);
  assert.equal(mistral.tokens, 300);
  assert.deepEqual(mistral.cost, [{ currency: 'USD', amount: '3.4' }]);
  assert.deepEqual(mistral.spend, [{ currency: 'USD', amount: '11' }]);
  assert.deepEqual(mistral.profit, [{ currency: 'USD', amount: '7.6' }]);
  assert.deepEqual(mistral.margin, [{ currency: 'USD', amount: '7.6', marginPercent: 69.09 }]);
  assert.deepEqual(mistral.providers, ['xkiro']);
  assert.deepEqual(mistral.upstreamModels, ['mistralai/mistral-large']);
  assert.equal(mistral.routes, 1);
  assert.equal(mistral.enabledRoutes, 1);

  const devstral = report.models[1];
  assert.deepEqual(devstral.spend, [{ currency: 'EUR', amount: '3' }]);
  assert.deepEqual(devstral.profit, []);
  assert.deepEqual(devstral.margin, [{ currency: 'EUR', amount: '0', marginPercent: 0 }]);
});

test('buildModelAnalytics detalha usuários do modelo com valores liquidados e rótulos mascarados', () => {
  const report = buildModelAnalytics({ ...input(), model: 'anubis/mistral' });
  assert.equal(report.model.model, 'anubis/mistral');
  assert.deepEqual(report.model.aliases, ['anubis/mistral', 'mistralai/mistral-large']);
  assert.equal(report.model.users.length, 2);
  const [alan, bia] = report.model.users;
  assert.equal(alan.keyId, 'k1');
  assert.equal(alan.name, 'Alan');
  assert.equal(alan.label, 'anubis_alan_••••••••');
  assert.equal(alan.planName, 'Pro');
  assert.equal(alan.active, true);
  assert.deepEqual(alan.cost, [{ currency: 'USD', amount: '1.4' }]);
  assert.deepEqual(alan.spend, [{ currency: 'USD', amount: '7' }]);
  assert.deepEqual(alan.profit, [{ currency: 'USD', amount: '5.6' }]);
  assert.deepEqual(alan.margin, [{ currency: 'USD', amount: '5.6', marginPercent: 80 }]);
  assert.equal(bia.keyId, 'k2');
  assert.equal(bia.active, false);
  assert.deepEqual(bia.profit, [{ currency: 'USD', amount: '2' }]);

  const alias = buildModelAnalytics({ ...input(), model: 'mistralai/mistral-large' });
  assert.equal(alias.model.model, 'anubis/mistral');
});

test('buildModelAnalytics não expõe chave completa, hash, prompt, resposta ou segredo', () => {
  const report = buildModelAnalytics({ ...input(), model: 'anubis/mistral' });
  const text = JSON.stringify(report);
  for (const needle of ['hash-secreto', 'segredo-fornecedor', 'prompt privado', 'resposta privada', 'apiKey', 'anubis_alan_full']) {
    assert.equal(text.includes(needle), false, needle);
  }
});

test('buildModelAnalytics valida período, modelo e ausência de dados', () => {
  assert.match(buildModelAnalytics({ period: { from: '22/11/2026' } }).error, /ISO UTC/);
  assert.match(buildModelAnalytics({ ...input(), period: { from: PERIOD.to, to: PERIOD.from } }).error, /anterior ao fim/);
  assert.match(buildModelAnalytics({ ...input(), model: 'modelo inválido' }).error, /Modelo inválido/);
  const missing = buildModelAnalytics({ ...input(), model: 'anubis/inexistente' });
  assert.equal(missing.missing, true);
  assert.match(missing.error, /sem dados/);
});

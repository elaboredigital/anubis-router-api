import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicCatalog, salePrice, uptimeFor, modelFamily } from '../src/public-catalog.js';

const now = Date.parse('2026-11-25T12:30:00Z');
const connection = { provider: 'wusrouter', models: [
  { id: 'up-claude', name: 'Claude Opus', billingType: 'token', pricing: { currency: 'USD', input: '1', output: '2', cacheRead: '0.1' } },
  { id: 'up-gpt', name: 'GPT 5', billingType: 'request', planOnly: true, pricing: { currency: 'USD', request: '0.002' } },
] };
const routes = [
  { id: 'claude-opus', upstreamModel: 'up-claude', enabled: true, priority: 10 },
  { id: 'gpt-5', upstreamModel: 'up-gpt', enabled: true },
  { id: 'disabled', upstreamModel: 'up-gpt', enabled: false },
];

test('preço de venda aplica multiplicador e preço manual prevalece', () => {
  assert.deepEqual(salePrice({ billingType: 'token', currency: 'USD', input: '1', output: '2', cacheRead: '0.1', cacheWrite: null }, { multiplier: '5' }),
    { billingType: 'token', currency: 'USD', request: null, input: '5', output: '10', cacheRead: '0.5', cacheWrite: null });
  assert.equal(salePrice({ billingType: 'request', request: '0.002' }, { manualPrice: { basis: 'per_request', request: '0.01', currency: 'USD' } }).request, '0.01');
  assert.equal(salePrice(null, { multiplier: '5' }), null);
});

test('uptime usa o desfecho final por requisição em 24 baldes horários', () => {
  const at = h => new Date(now - h * 3600_000).toISOString();
  const records = [
    { requestId: 'a', publicModel: 'm', status: 'upstream_error', startedAt: at(1) },
    { requestId: 'a', publicModel: 'm', status: 'completed', startedAt: at(1), usage: { inputTokens: 100, cachedInputTokens: 25 } },
    { requestId: 'b', publicModel: 'm', status: 'upstream_error', startedAt: at(0) },
    { requestId: 'c', publicModel: 'm', status: 'cancelled', startedAt: at(0) },
    { requestId: 'd', publicModel: 'm', status: 'completed', startedAt: at(30) },
  ];
  const result = uptimeFor(records, 'm', now);
  assert.equal(result.timeline.length, 24);
  assert.equal(result.uptime, 50);
  assert.equal(result.cacheHitRate, 25);
  assert.equal(result.timeline[23], 0);
  assert.equal(result.timeline[22], 100);
  assert.equal(result.timeline[0], null);
});

test('catálogo público não expõe custo nem conexão', () => {
  const data = buildPublicCatalog({ routes, connectionForRoute: () => connection, resolve: () => ({ multiplier: '5' }), now });
  assert.deepEqual(data.map(m => m.id), ['claude-opus', 'gpt-5']);
  assert.equal(data[0].family, 'anthropic');
  assert.equal(data[0].price.input, '5');
  assert.equal(data[1].price.request, '0.01');
  assert.equal(data[1].planOnly, true);
  const text = JSON.stringify(data);
  assert.doesNotMatch(text, /up-claude|wusrouter|"1"|connection/);
});

test('família deduzida do nome', () => {
  assert.equal(modelFamily('jailbreak/claude-fable-5'), 'anthropic');
  assert.equal(modelFamily('glm-5'), 'zai');
  assert.equal(modelFamily('kimi-k3'), 'moonshot');
});

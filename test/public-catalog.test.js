import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdminAvailability, buildPublicCatalog, salePrice, uptimeFor, modelFamily, modelPricing, averageCost } from '../src/public-catalog.js';

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

test('venda usa a média de custo entre os fornecedores × multiplicador', () => {
  const a = { id: 'a', provider: 'p1', models: [{ id: 'm', billingType: 'token', pricing: { currency: 'USD', input: '1', output: '4' } }] };
  const b = { id: 'b', provider: 'p2', models: [{ id: 'm', billingType: 'token', pricing: { currency: 'USD', input: '2', output: '6', cacheRead: '0.2' } }] };
  const c = { id: 'c', provider: 'p3', models: [{ id: 'm', billingType: 'token', pricing: { currency: 'USD', input: '3', output: '8' } }] };
  const byConnection = { a, b, c };
  const three = [
    { id: 'modelo', upstreamModel: 'm', connectionId: 'a', enabled: true, priority: 1 },
    { id: 'modelo', upstreamModel: 'm', connectionId: 'b', enabled: true, priority: 2 },
    { id: 'modelo', upstreamModel: 'm', connectionId: 'c', enabled: true, priority: 3 },
    { id: 'modelo', upstreamModel: 'm', connectionId: 'c', enabled: false, priority: 4 },
  ];
  const [item] = modelPricing({ routes: three, connectionForRoute: r => byConnection[r.connectionId], resolve: () => ({ multiplier: '5' }) });
  assert.equal(item.suppliers.length, 3);
  assert.equal(item.referenceCost.suppliers, 3);
  assert.equal(item.referenceCost.input, '2');
  assert.equal(item.referenceCost.output, '6');
  assert.equal(item.referenceCost.cacheRead, '0.2', 'campo informado por um só fornecedor usa só esse valor');
  assert.equal(item.sale.input, '10');
  assert.equal(item.sale.output, '30');
  const [single] = modelPricing({ routes: three.slice(0, 1), connectionForRoute: r => byConnection[r.connectionId], resolve: () => ({ multiplier: '5' }) });
  assert.equal(single.sale.input, '5');
});

test('média ignora fornecedor em outra unidade quando há maioria', () => {
  const avg = averageCost([
    { billingType: 'token', currency: 'USD', input: '1', output: '1' },
    { billingType: 'request', currency: 'USD', request: '0.5' },
    { billingType: 'token', currency: 'USD', input: '3', output: '5' },
  ]);
  assert.equal(avg.billingType, 'token');
  assert.equal(avg.suppliers, 2);
  assert.equal(avg.input, '2');
  assert.equal(averageCost([null]), null);
});

test('catálogo público mostra preço original e desconto sem expor custo', () => {
  const [item] = buildPublicCatalog({ routes: routes.slice(0, 1), connectionForRoute: () => connection, resolve: () => ({ multiplier: '5' }), originals: { 'claude-opus': { currency: 'USD', input: '15', output: '75' } }, now });
  assert.equal(item.originalPrice.input, '15');
  assert.equal(item.originalPrice.discount.input, 67);
  assert.equal(item.originalPrice.discount.output, 87);
  assert.equal(item.originalPrice.discount.cacheRead, null);
});

test('preço original sem desconto não sai no catálogo público', () => {
  const [item] = buildPublicCatalog({ routes: routes.slice(0, 1), connectionForRoute: () => connection, resolve: () => ({ multiplier: '5' }), originals: { 'claude-opus': { currency: 'USD', input: '1', output: '2' } }, now });
  assert.equal(item.originalPrice, null);
});

test('disponibilidade do admin repete o catálogo público e soma tentativas por fornecedor', () => {
  const a = { id: 'conn-a', name: 'A', provider: 'wusrouter', models: connection.models };
  const b = { id: 'conn-b', name: 'B', provider: 'maxrouter', models: connection.models };
  const twoRoutes = [{ ...routes[0], connectionId: 'conn-a' }, { ...routes[0], connectionId: 'conn-b', priority: 20 }];
  const byId = { 'conn-a': a, 'conn-b': b };
  const at = h => new Date(now - h * 3600_000).toISOString();
  const records = [
    { requestId: 'r1', publicModel: 'claude-opus', connectionId: 'conn-a', status: 'upstream_error', httpStatus: 503, failure: { reason: 'resposta_http' }, startedAt: at(1) },
    { requestId: 'r1', publicModel: 'claude-opus', connectionId: 'conn-b', status: 'completed', startedAt: at(1) },
    { requestId: 'r2', publicModel: 'claude-opus', connectionId: 'conn-a', status: 'completed', startedAt: at(0) },
    { requestId: 'r3', publicModel: 'claude-opus', connectionId: 'conn-a', status: 'completed', startedAt: at(40) },
  ];
  const args = { routes: twoRoutes, connectionForRoute: r => byId[r.connectionId], resolve: () => ({ multiplier: '5' }), records, now };
  const [publicItem] = buildPublicCatalog(args);
  const [item] = buildAdminAvailability({ ...args, connections: [{ id: 'conn-a', status: 'valid', checkedAt: at(2) }, { id: 'conn-b', status: 'invalid' }] });
  assert.deepEqual(item.price, publicItem.price);
  assert.equal(item.uptime, 100);
  assert.deepEqual(item.suppliers.map(s => [s.connectionId, s.connectionStatus, s.attempts, s.failures, s.successRate]), [['conn-a', 'valid', 2, 1, 50], ['conn-b', 'invalid', 1, 0, 100]]);
  assert.equal(item.suppliers[0].lastFailure.httpStatus, 503);
  assert.equal(item.suppliers[0].lastOkAt, at(0));
});

test('venda por chamada é comparada com a tabela por token numa chamada típica', () => {
  const perCall = { provider: 'wusrouter', models: [{ id: 'up', name: 'Claude Opus 5.5', billingType: 'request', pricing: { request: '0.02' } }] };
  const [item] = buildPublicCatalog({ routes: [{ id: 'anubis/claude-opus-5.5', upstreamModel: 'up', enabled: true }], connectionForRoute: () => perCall,
    resolve: () => ({ manualPrice: { basis: 'per_request', currency: 'USD', request: '0.035' } }), originals: { 'anubis/claude-opus-5.5': { currency: 'USD', input: '4', output: '20' } }, now });
  assert.equal(item.price.request, '0.035');
  // 25 mil de entrada × US$ 4/1M + 2,5 mil de saída × US$ 20/1M = US$ 0,15.
  assert.equal(item.originalPrice.request, '0.15');
  assert.equal(item.originalPrice.discount.request, 77);
  assert.deepEqual(item.originalPrice.typicalCall, { input: 25000, output: 2500 });
});

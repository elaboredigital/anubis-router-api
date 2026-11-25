import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROUTING_POLICY, normalizeRoutingPolicy, validateRoutingPolicy,
  normalizeRoutingFields, validateRoutingFields, orderedCandidates, nextCursor,
  shouldRetry, resolveTimeout, isCoolingDown, buildRouteAudit,
} from '../src/routing-policy.js';

test('normalizeRoutingPolicy preserva o padrão sem alterar o comportamento atual', () => {
  assert.deepEqual(normalizeRoutingPolicy({}), DEFAULT_ROUTING_POLICY);
  assert.deepEqual(normalizeRoutingPolicy({
    strategy: 'weighted', maxAttempts: '4', retryStatuses: '429, 500, 503',
    timeoutMs: '1500', cooldownMs: '2000',
  }), {
    strategy: 'weighted', maxAttempts: 4, retryStatuses: [429, 500, 503],
    timeoutMs: 1500, cooldownMs: 2000, failoverOnError: true,
  });
  assert.deepEqual(normalizeRoutingPolicy({ retryStatuses: [], maxAttempts: '', timeoutMs: '' }), {
    ...DEFAULT_ROUTING_POLICY, retryStatuses: [], maxAttempts: null, timeoutMs: null,
  });
  assert.equal(normalizeRoutingPolicy({ failoverOnError: 'false' }).failoverOnError, false);
});

test('validateRoutingPolicy rejeita estratégia, limites e status inválidos', () => {
  assert.equal(validateRoutingPolicy(DEFAULT_ROUTING_POLICY), null);
  assert.match(validateRoutingPolicy({ ...DEFAULT_ROUTING_POLICY, strategy: 'aleatoria' }), /estratégia/i);
  assert.match(validateRoutingPolicy({ ...DEFAULT_ROUTING_POLICY, maxAttempts: 0 }), /tentativas/i);
  assert.match(validateRoutingPolicy({ ...DEFAULT_ROUTING_POLICY, maxAttempts: 11 }), /tentativas/i);
  assert.match(validateRoutingPolicy({ ...DEFAULT_ROUTING_POLICY, retryStatuses: [400] }), /status/i);
  assert.match(validateRoutingPolicy({ ...DEFAULT_ROUTING_POLICY, timeoutMs: -1 }), /timeout/i);
  assert.match(validateRoutingPolicy({ ...DEFAULT_ROUTING_POLICY, cooldownMs: -1 }), /resfriamento/i);
  assert.match(validateRoutingPolicy({ ...DEFAULT_ROUTING_POLICY, failoverOnError: 'sim' }), /failover/i);
});

test('normalizeRoutingFields aceita peso opcional e data de resfriamento válida', () => {
  assert.deepEqual(normalizeRoutingFields({}), { weight: 1, cooldownUntil: null });
  assert.deepEqual(normalizeRoutingFields({ weight: '4', cooldownUntil: '2026-11-24T10:00:00.000Z' }), { weight: 4, cooldownUntil: '2026-11-24T10:00:00.000Z' });
  assert.equal(validateRoutingFields(normalizeRoutingFields({ weight: '4' })), null);
  assert.match(validateRoutingFields(normalizeRoutingFields({ weight: 0 })), /peso/i);
  assert.match(validateRoutingFields(normalizeRoutingFields({ weight: 'muitos' })), /peso/i);
  assert.match(validateRoutingFields(normalizeRoutingFields({ cooldownUntil: 'amanhã' })), /resfriamento/i);
});

test('orderedCandidates mantém prioridade e respeita pesos dentro do mesmo nível', () => {
  const candidates = [
    { destinationId: 'baixo', priority: 10, weight: 1 },
    { destinationId: 'alto', priority: 20, weight: 1000 },
  ];
  assert.deepEqual(orderedCandidates(candidates, { strategy: 'weighted' }, 'req-1').map(item => item.destinationId), ['baixo', 'alto']);
  const weighted = [
    { destinationId: 'a', priority: 100, weight: 4 },
    { destinationId: 'b', priority: 100, weight: 1 },
  ];
  let firstA = 0;
  for (let i = 0; i < 400; i++) {
    if (orderedCandidates(weighted, { strategy: 'weighted' }, `req-${i}`)[0].destinationId === 'a') firstA++;
  }
  assert.ok(firstA > 260 && firstA < 360, `distribuição inesperada: ${firstA}/400`);
  assert.deepEqual(orderedCandidates(weighted, { strategy: 'priority' }, 'req-1').map(item => item.destinationId), ['a', 'b']);
  assert.deepEqual(orderedCandidates(weighted, { strategy: 'round_robin' }, 0).map(item => item.destinationId), ['a', 'b']);
  assert.deepEqual(orderedCandidates(weighted, { strategy: 'round_robin' }, 1).map(item => item.destinationId), ['b', 'a']);
  assert.equal(nextCursor({ strategy: 'round_robin' }, 1, 2), 3);
  assert.equal(nextCursor({ strategy: 'priority' }, 1, 2), 1);
});

test('shouldRetry respeita status, tentativas e limite configurado', () => {
  assert.equal(shouldRetry(DEFAULT_ROUTING_POLICY, 500, 1, 3), true);
  assert.equal(shouldRetry(DEFAULT_ROUTING_POLICY, 400, 1, 3), false);
  assert.equal(shouldRetry(DEFAULT_ROUTING_POLICY, 404, 1, 3), true);
  assert.equal(shouldRetry(DEFAULT_ROUTING_POLICY, 500, 3, 3), false);
  assert.equal(shouldRetry({ ...DEFAULT_ROUTING_POLICY, maxAttempts: 1 }, 503, 1, 3), false);
  assert.equal(shouldRetry({ ...DEFAULT_ROUTING_POLICY, failoverOnError: false, retryStatuses: [429] }, 503, 1, 3), false);
});

test('resolveTimeout usa o valor configurado e mantém o padrão do ambiente', () => {
  assert.equal(resolveTimeout(DEFAULT_ROUTING_POLICY, 30000), 30000);
  assert.equal(resolveTimeout({ timeoutMs: 1500 }, 30000), 1500);
});

test('isCoolingDown considera apenas resfriamentos futuros', () => {
  assert.equal(isCoolingDown({ cooldownUntil: '2999-01-01T00:00:00.000Z' }, Date.parse('2026-11-24T00:00:00.000Z')), true);
  assert.equal(isCoolingDown({ cooldownUntil: '2020-01-01T00:00:00.000Z' }, Date.parse('2026-11-24T00:00:00.000Z')), false);
  assert.equal(isCoolingDown({}, Date.parse('2026-11-24T00:00:00.000Z')), false);
});

test('buildRouteAudit registra mudança sem segredos nem prompts', () => {
  const before = { destinationId: 'a', provider: 'xkiro', secret: 'segredo', priority: 100 };
  const after = { destinationId: 'a', provider: 'xkiro', secret: 'outro', priority: 200 };
  const event = buildRouteAudit('rotate', 'anubis/devstral', before, after, 'rotação manual', '2026-11-24T10:00:00.000Z');
  assert.equal(event.at, '2026-11-24T10:00:00.000Z');
  assert.equal(event.action, 'rotate');
  assert.equal(event.target, 'anubis/devstral');
  assert.equal(event.detail, 'rotação manual');
  assert.equal(event.before.priority, 100);
  assert.equal(event.after.priority, 200);
  assert.equal(JSON.stringify(event).includes('segredo'), false);
});

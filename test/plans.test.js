import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FREE_PLAN, validatePlan, monthWindow, dayWindow, usageInWindow, checkPlanQuota, checkDailyQuota, planAllowsModel, planMultiplier, buildKeyBilling } from '../src/plans.js';

const record = (overrides = {}) => ({
  clientKeyId: 'k1', requestId: 'r1', id: 'a1', status: 'completed', startedAt: '2026-11-05T12:00:00.000Z',
  usage: { inputTokens: 100, outputTokens: 20 },
  costSnapshot: { billingType: 'request', currency: 'USD', request: '0.02' },
  ...overrides,
});

test('validatePlan aceita limites nulos e rejeita valores que não podem ser aplicados', () => {
  assert.equal(validatePlan({ name: 'Gratuito', kind: 'free', monthlyRequests: 100, monthlyTokens: 1000000, models: ['meu/modelo'], multiplier: '5', active: true }), null);
  assert.equal(validatePlan({ name: 'Sem limite', kind: 'paid', monthlyRequests: null, monthlyTokens: null, models: [], multiplier: null, active: true }), null);
  assert.equal(validatePlan({ name: 'PAYG', kind: 'payg', monthlyRequests: null, monthlyTokens: null, models: ['meu/modelo'], multiplier: null, currency: 'USD', active: true }), null);
  assert.match(validatePlan({ name: 'PAYG', kind: 'payg', monthlyRequests: null, monthlyTokens: null, models: ['meu/modelo'], multiplier: null, currency: '', active: true }), /moeda/i);
  assert.match(validatePlan({ name: '', kind: 'free', monthlyRequests: 1, monthlyTokens: 1, models: [], multiplier: '5', active: true }), /nome/i);
  assert.match(validatePlan({ name: 'Teste', kind: 'vip', monthlyRequests: 1, monthlyTokens: 1, models: [], multiplier: '5', active: true }), /tipo/i);
  assert.match(validatePlan({ name: 'Teste', kind: 'free', monthlyRequests: -1, monthlyTokens: 1, models: [], multiplier: '5', active: true }), /requisições/i);
  assert.match(validatePlan({ name: 'Teste', kind: 'free', monthlyRequests: 1.5, monthlyTokens: 1, models: [], multiplier: '5', active: true }), /requisições/i);
  assert.match(validatePlan({ name: 'Teste', kind: 'free', monthlyRequests: 1, monthlyTokens: 1, models: ['modelo inválido'], multiplier: '5', active: true }), /modelo/i);
  assert.match(validatePlan({ name: 'Teste', kind: 'free', monthlyRequests: 1, monthlyTokens: 1, models: [], multiplier: '0', active: true }), /multiplicador/i);
});

test('monthWindow usa limites UTC do mês corrente', () => {
  assert.deepEqual(monthWindow(new Date('2026-11-24T10:30:00.000Z')), {
    start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z',
  });
  assert.deepEqual(monthWindow(new Date('2026-12-31T23:59:59.999Z')), {
    start: '2026-12-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z',
  });
});

test('dayWindow usa a virada UTC do dia e o plano gratuito começa com 500 mil tokens/dia', () => {
  assert.deepEqual(dayWindow(new Date('2026-11-24T10:30:00.000Z')), {
    start: '2026-11-24T00:00:00.000Z', end: '2026-11-25T00:00:00.000Z',
  });
  assert.equal(DEFAULT_FREE_PLAN.dailyTokens, 500000);
  assert.equal(validatePlan({ ...DEFAULT_FREE_PLAN, dailyTokens: 0, models: ['meu/modelo'] }), 'Limite de tokens diários inválido.');
});

test('checkDailyQuota bloqueia pelo consumo do dia, inclusive chamadas canceladas', () => {
  const window = dayWindow(new Date('2026-11-24T10:30:00.000Z'));
  const usage = usageInWindow([
    record({ startedAt: '2026-11-24T09:00:00.000Z', usage: { inputTokens: 300, outputTokens: 100 } }),
    record({ id: 'b1', requestId: 'r2', status: 'cancelled', startedAt: '2026-11-24T09:30:00.000Z', usage: { inputTokens: 100 } }),
    record({ id: 'b2', requestId: 'r3', startedAt: '2026-11-23T09:00:00.000Z', usage: { inputTokens: 900 } }),
  ], 'k1', window, ['completed', 'cancelled']);
  assert.deepEqual(usage, { requests: 2, tokens: 500, window });
  const plan = { ...DEFAULT_FREE_PLAN, dailyTokens: 500 };
  assert.deepEqual(checkDailyQuota(plan, usage), { allowed: false, reason: 'daily_tokens', used: 500, limit: 500, resetAt: window.end });
  assert.equal(checkDailyQuota({ ...plan, dailyTokens: 501 }, usage).allowed, true);
  assert.equal(checkDailyQuota(null, usage).allowed, true);
});

test('usageInWindow não conta duas tentativas da mesma requisição nem uso cancelado ou de outra chave', () => {
  const window = monthWindow(new Date('2026-11-24T10:30:00.000Z'));
  const usage = usageInWindow([
    record(),
    record({ id: 'a2', status: 'upstream_error', requestId: 'r1', usage: { inputTokens: 999 } }),
    record({ id: 'a3', requestId: 'r2', usage: { inputTokens: 50, outputTokens: 5 } }),
    record({ id: 'a4', status: 'cancelled', requestId: 'r3', usage: { inputTokens: 1000 } }),
    record({ id: 'a5', clientKeyId: 'k2', requestId: 'r4', usage: { inputTokens: 700 } }),
    record({ id: 'a6', requestId: 'r5', startedAt: '2026-10-31T23:59:59.000Z', usage: { inputTokens: 800 } }),
  ], 'k1', window);
  assert.deepEqual(usage, { requests: 2, tokens: 175, window });
});

test('checkPlanQuota bloqueia por requisições, tokens e plano inativo, mas permite chave sem plano', () => {
  const window = monthWindow(new Date('2026-11-24T10:30:00.000Z'));
  const usage = { requests: 3, tokens: 100, window };
  const plan = { ...DEFAULT_FREE_PLAN, monthlyRequests: 3, monthlyTokens: 1000 };
  assert.deepEqual(checkPlanQuota(plan, usage), { allowed: false, reason: 'requests', used: 3, limit: 3, resetAt: window.end });
  assert.deepEqual(checkPlanQuota({ ...plan, monthlyRequests: 10, monthlyTokens: 100 }, usage), { allowed: false, reason: 'tokens', used: 100, limit: 100, resetAt: window.end });
  assert.deepEqual(checkPlanQuota({ ...plan, active: false }, usage), { allowed: false, reason: 'inactive', used: 3, limit: null, resetAt: window.end });
  assert.equal(checkPlanQuota({ ...plan, monthlyRequests: 4 }, usage).allowed, true);
  assert.equal(checkPlanQuota(null, usage).allowed, true);
});

test('planAllowsModel exige seleção explícita quando o plano existe', () => {
  assert.equal(planAllowsModel(null, 'meu/modelo'), true);
  assert.equal(planAllowsModel(DEFAULT_FREE_PLAN, 'meu/modelo'), false);
  assert.equal(planAllowsModel({ ...DEFAULT_FREE_PLAN, models: ['meu/modelo'] }, 'meu/modelo'), true);
  assert.equal(planAllowsModel({ ...DEFAULT_FREE_PLAN, models: ['meu/modelo'] }, 'outro/modelo'), false);
});

test('planMultiplier usa o multiplicador do plano ou o padrão global de 5 vezes', () => {
  assert.equal(planMultiplier(null, '5'), '5');
  assert.equal(planMultiplier({ multiplier: null }, '5'), '5');
  assert.equal(planMultiplier({ multiplier: '3' }, '5'), '3');
});

test('buildKeyBilling mostra custo, venda sugerida com 5x e margem sem misturar moedas', () => {
  const now = new Date('2026-11-24T10:30:00.000Z');
  const keys = [{ id: 'k1', planId: 'plano-5x' }, { id: 'k2', planId: 'plano-3x' }];
  const plans = [
    { id: 'plano-5x', name: 'Padrão', monthlyRequests: 100, monthlyTokens: 1000000, models: [], multiplier: null, active: true },
    { id: 'plano-3x', name: 'Promo', monthlyRequests: 10, monthlyTokens: 500, models: [], multiplier: '3', active: true },
  ];
  const records = [
    record({ clientKeyId: 'k1', requestId: 'r1', costSnapshot: { billingType: 'request', currency: 'USD', request: '0.02' } }),
    record({ clientKeyId: 'k1', requestId: 'r2', costSnapshot: { billingType: 'request', currency: 'BRL', request: '0.10' } }),
    record({ clientKeyId: 'k1', requestId: 'r3', status: 'upstream_error', costSnapshot: { billingType: 'request', currency: 'USD', request: '99' } }),
    record({ clientKeyId: 'k2', requestId: 'r4', costSnapshot: { billingType: 'request', currency: 'USD', request: '0.02' } }),
    record({ clientKeyId: 'k1', requestId: 'r5', startedAt: '2026-10-31T23:59:59.000Z', costSnapshot: { billingType: 'request', currency: 'USD', request: '99' } }),
    record({ clientKeyId: 'k1', requestId: 'r6', status: 'cancelled', costSnapshot: { billingType: 'request', currency: 'USD', request: '99' } }),
  ];
  const [first, second] = buildKeyBilling(keys, records, plans, '5', now);
  assert.equal(first.planName, 'Padrão');
  assert.equal(first.usage.requests, 2);
  assert.equal(first.sales.find(item => item.currency === 'USD').sale, '0.1');
  assert.equal(first.sales.find(item => item.currency === 'USD').marginPercent, 80);
  assert.equal(first.sales.find(item => item.currency === 'BRL').sale, '0.5');
  assert.equal(second.sales[0].sale, '0.06');
  assert.equal(second.sales[0].marginPercent, 66.7);
});

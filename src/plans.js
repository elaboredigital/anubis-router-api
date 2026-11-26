// Planos e limites são simulação administrativa: não há reserva, cobrança nem franquia de fornecedor aqui.
import { decimalUnits, formatUnits, recordCost } from './dashboard.js';

const MODEL_ID = /^[\w./:-]{1,160}$/;
const SCALE = 10n ** 12n;
export const DEFAULT_FREE_PLAN = Object.freeze({
  id: 'free',
  name: 'Gratuito',
  kind: 'free',
  monthlyRequests: null,
  monthlyTokens: null,
  dailyRequests: null,
  // Franquia diária do cliente: o consumo vale mesmo quando o fornecedor free não informa tokens.
  dailyTokens: 500000,
  models: [],
  multiplier: null,
  active: true,
  selfService: true,
});

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') return 'Plano inválido.';
  if (typeof plan.name !== 'string' || !plan.name.trim() || plan.name.trim().length > 80) return 'Informe um nome com até 80 caracteres.';
  if (!['free', 'paid', 'payg'].includes(plan.kind)) return 'Tipo de plano inválido.';
  if (plan.kind === 'payg' && (typeof plan.currency !== 'string' || !/^[A-Z]{3}$/.test(plan.currency))) return 'Moeda da carteira PAYG inválida.';
  for (const [field, label] of [['monthlyRequests', 'requisições'], ['monthlyTokens', 'tokens'], ['dailyRequests', 'requisições diárias'], ['dailyTokens', 'tokens diários']]) {
    const value = plan[field];
    if (value === null || value === undefined || value === '') continue;
    if (!Number.isSafeInteger(value) || value < 1) return `Limite de ${label} inválido.`;
  }
  if (!Array.isArray(plan.models) || plan.models.length > 500 || plan.models.some(id => typeof id !== 'string' || !MODEL_ID.test(id))) return 'Modelos do plano inválidos.';
  if (plan.multiplier !== null && plan.multiplier !== undefined && plan.multiplier !== '') {
    const units = typeof plan.multiplier === 'string' ? decimalUnits(plan.multiplier) : null;
    if (units === null || units <= 0n) return 'Multiplicador deve ser maior que zero.';
  }
  if (typeof plan.active !== 'boolean') return 'Estado do plano inválido.';
  if (plan.selfService !== undefined && typeof plan.selfService !== 'boolean') return 'Disponibilidade do plano para o cliente inválida.';
  return null;
}

export function monthWindow(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

export function dayWindow(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Conta chamadas encerradas na janela; tentativas repetidas da mesma requisição não contam duas vezes. */
export function usageInWindow(records, keyId, window, statuses = ['completed']) {
  const accepted = new Set(statuses);
  const seen = new Set();
  let requests = 0;
  let tokens = 0;
  for (const record of records) {
    if (!record || record.clientKeyId !== keyId || !accepted.has(record.status)) continue;
    const at = record.startedAt || record.finishedAt;
    if (!at || at < window.start || at >= window.end) continue;
    const id = record.requestId || record.id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    requests++;
    for (const field of ['inputTokens', 'outputTokens']) {
      const value = record.usage?.[field];
      if (Number.isSafeInteger(value) && value >= 0) tokens += value;
    }
  }
  return { requests, tokens, window };
}

export function checkPlanQuota(plan, usage) {
  const resetAt = usage?.window?.end || monthWindow().end;
  if (!plan) return { allowed: true, reason: null, used: usage?.requests ?? 0, limit: null, resetAt };
  const requests = usage?.requests ?? 0;
  const tokens = usage?.tokens ?? 0;
  if (plan.active === false) return { allowed: false, reason: 'inactive', used: requests, limit: null, resetAt };
  if (plan.monthlyRequests != null && requests >= plan.monthlyRequests) return { allowed: false, reason: 'requests', used: requests, limit: plan.monthlyRequests, resetAt };
  if (plan.monthlyTokens != null && tokens >= plan.monthlyTokens) return { allowed: false, reason: 'tokens', used: tokens, limit: plan.monthlyTokens, resetAt };
  return { allowed: true, reason: null, used: requests, limit: plan.monthlyRequests ?? null, resetAt };
}

export function checkDailyQuota(plan, usage) {
  const resetAt = usage?.window?.end || dayWindow().end;
  if (!plan) return { allowed: true, reason: null, used: usage?.tokens ?? 0, limit: null, resetAt };
  const requests = usage?.requests ?? 0;
  const tokens = usage?.tokens ?? 0;
  if (plan.active === false) return { allowed: false, reason: 'inactive', used: requests, limit: null, resetAt };
  if (plan.dailyRequests != null && requests >= plan.dailyRequests) return { allowed: false, reason: 'daily_requests', used: requests, limit: plan.dailyRequests, resetAt };
  if (plan.dailyTokens != null && tokens >= plan.dailyTokens) return { allowed: false, reason: 'daily_tokens', used: tokens, limit: plan.dailyTokens, resetAt };
  return { allowed: true, reason: null, used: plan.dailyTokens != null ? tokens : requests, limit: plan.dailyTokens ?? plan.dailyRequests ?? null, resetAt };
}

export function planAllowsModel(plan, modelId) {
  if (!plan) return true;
  // Créditos pré-pagos sem lista de modelos liberam todo o catálogo: o saldo é o limite.
  if (plan.kind === 'payg' && (!Array.isArray(plan.models) || !plan.models.length)) return true;
  return Array.isArray(plan.models) && plan.models.includes(modelId);
}

export function planMultiplier(plan, defaultMultiplier) {
  return plan?.multiplier || defaultMultiplier || '5';
}

/** Custo apurado nas chamadas concluídas do mês e preço de venda sugerido pelo multiplicador do plano. */
export function buildKeyBilling(keys, records, plans = [], defaultMultiplier = '5', now = new Date()) {
  const window = monthWindow(now);
  return keys.map(key => {
    const plan = plans.find(item => item.id === key.planId) || null;
    const usage = usageInWindow(records, key.id, window);
    const quota = checkPlanQuota(plan, usage);
    const totals = new Map();
    for (const record of records) {
      if (!record || record.clientKeyId !== key.id || record.status !== 'completed') continue;
      const at = record.startedAt || record.finishedAt;
      if (!at || at < window.start || at >= window.end) continue;
      const cost = recordCost(record);
      if (!cost) continue;
      totals.set(cost.currency, (totals.get(cost.currency) || 0n) + cost.units);
    }
    const multiplier = planMultiplier(plan, defaultMultiplier);
    const units = decimalUnits(multiplier);
    const marginPercent = Math.round((1 - 1 / Number(multiplier)) * 1000) / 10;
    const sales = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, cost]) => ({
      currency, cost: formatUnits(cost), sale: formatUnits(cost * units / SCALE), multiplier, marginPercent,
    }));
    return {
      keyId: key.id, planId: plan?.id || null, planName: plan?.name || null,
      window, usage: { requests: usage.requests, tokens: usage.tokens },
      limits: { requests: plan?.monthlyRequests ?? null, tokens: plan?.monthlyTokens ?? null },
      allowed: quota.allowed, reason: quota.reason, sales,
    };
  });
}

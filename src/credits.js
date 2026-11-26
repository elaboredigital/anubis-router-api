// Créditos pré-pagos do cliente: o cliente pede uma recarga ($5, $10 ou mais), o admin confirma o pagamento
// e o valor vira uma recarga na carteira da conta. Cada chamada concluída desconta o preço de venda do modelo.
// Não há checkout aqui: a confirmação do pagamento é feita por uma pessoa no admin.
import { decimalUnits, formatUnits } from './dashboard.js';

export const CREDIT_PLAN = Object.freeze({
  id: 'credits', name: 'Créditos', kind: 'payg', currency: 'USD',
  monthlyRequests: null, monthlyTokens: null, dailyRequests: null, dailyTokens: null,
  models: [], multiplier: null, active: true, selfService: true,
});
export const TOPUP_PRESETS = Object.freeze(['5', '10', '25', '50', '100']);
export const MIN_TOPUP = '5';
export const MAX_TOPUP = '10000';
export const MAX_PENDING_REQUESTS = 3;
const AMOUNT = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/;

/** Garante o plano de créditos sem alterar um plano com o mesmo ID já configurado pelo admin. */
export function ensureCreditPlan(plans) {
  const list = Array.isArray(plans) ? plans : [];
  return list.some(plan => plan?.id === CREDIT_PLAN.id) ? list : [...list, { ...CREDIT_PLAN }];
}

export function validateTopupRequest(data, pending = 0) {
  const amount = typeof data?.amount === 'number' ? String(data.amount) : typeof data?.amount === 'string' ? data.amount.trim() : '';
  if (!AMOUNT.test(amount)) return { error: 'Informe um valor em dólar com até duas casas decimais.' };
  const units = decimalUnits(amount);
  if (units < decimalUnits(MIN_TOPUP)) return { error: `A recarga mínima é de US$ ${MIN_TOPUP}.` };
  if (units > decimalUnits(MAX_TOPUP)) return { error: `A recarga máxima por pedido é de US$ ${MAX_TOPUP}.` };
  if (pending >= MAX_PENDING_REQUESTS) return { error: `Você já tem ${MAX_PENDING_REQUESTS} pedidos aguardando confirmação.` };
  return { amount: formatUnits(units), currency: 'USD' };
}

/** O que o cliente vê de um pedido: sem observações internas do admin. */
export function clientTopupRequest(item) {
  return {
    id: item.id, amount: item.amount, currency: item.currency, status: item.status,
    createdAt: item.createdAt, decidedAt: item.decidedAt || null,
    reason: item.status === 'rejected' ? item.reason || null : null,
  };
}

/**
 * Extrato da conta: um lançamento por chamada cobrada, mais recente primeiro.
 * Nunca mostra custo do fornecedor, margem, conexão ou modelo de origem.
 */
export function clientStatement(entries, keys, limit = 50) {
  const names = new Map((Array.isArray(keys) ? keys : []).map(key => [key.id, typeof key.name === 'string' ? key.name : '']));
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && names.has(entry.keyId) && ['settled', 'pending_conversion'].includes(entry.status))
    .sort((a, b) => String(b.finishedAt || b.startedAt || '').localeCompare(String(a.finishedAt || a.startedAt || '')))
    .slice(0, Math.max(1, Math.min(200, limit)))
    .map(entry => ({
      requestId: entry.requestId, at: entry.finishedAt || entry.startedAt || null, model: entry.publicModel || null,
      keyName: names.get(entry.keyId) || '', amount: entry.sale, currency: entry.saleCurrency || entry.currency,
      status: entry.status === 'settled' ? 'charged' : 'pending',
    }));
}

/** Gasto somado por modelo no extrato, para o cliente ver onde o saldo foi usado. */
export function spendByModel(statement) {
  const totals = new Map();
  for (const item of statement) {
    if (item.status !== 'charged') continue;
    const units = decimalUnits(item.amount);
    if (units === null) continue;
    const key = `${item.model}\u0000${item.currency}`;
    const current = totals.get(key) || { model: item.model, currency: item.currency, units: 0n, requests: 0 };
    current.units += units; current.requests++;
    totals.set(key, current);
  }
  return [...totals.values()].sort((a, b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0))
    .map(item => ({ model: item.model, currency: item.currency, amount: formatUnits(item.units), requests: item.requests }));
}


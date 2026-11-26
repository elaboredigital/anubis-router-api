// Créditos pré-pagos do cliente: o cliente pede uma recarga ($5, $10 ou mais), o admin confirma o pagamento
// e o valor vira uma recarga na carteira da conta. Cada chamada concluída desconta o preço de venda do modelo.
// O pagamento é confirmado pelo admin, pela Payssion (página de pagamento hospedada) ou por um webhook assinado.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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


// Confirmação automática de pagamento: um gateway ou automação (ex.: n8n lendo o aviso de PIX) chama
// POST /payments/confirm com corpo JSON assinado: HMAC-SHA256(segredo, `${timestamp}.${corpo}`) em hex,
// nos cabeçalhos x-anubis-timestamp (ms) e x-anubis-signature. Sem ANUBIS_PAYMENT_WEBHOOK_SECRET, fica desligada.
export const PAYMENT_TOLERANCE_MS = 5 * 60_000;
export function paymentSignature(secret, timestamp, raw) {
  return createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
}
export function verifyPaymentSignature({ secret, timestamp, signature, raw, now = Date.now() }) {
  if (!secret || secret.length < 32) return 'Confirmação de pagamento desligada.';
  const at = Number(timestamp);
  if (!Number.isSafeInteger(at) || Math.abs(now - at) > PAYMENT_TOLERANCE_MS) return 'Carimbo de tempo ausente ou fora da janela de 5 minutos.';
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return 'Assinatura inválida.';
  const expected = Buffer.from(paymentSignature(secret, timestamp, raw), 'hex');
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given) ? null : 'Assinatura inválida.';
}
/** O pagamento precisa bater com o pedido: mesmo valor e moeda, com uma referência do pagamento. */
export function validatePaymentConfirmation(data, request) {
  if (!data || typeof data !== 'object') return 'Corpo inválido.';
  if (typeof data.reference !== 'string' || !/^[\w.:/-]{1,120}$/.test(data.reference)) return 'Informe a referência do pagamento.';
  if (!request) return 'Pedido não encontrado.';
  const paid = decimalUnits(typeof data.amount === 'number' ? String(data.amount) : data.amount);
  if (paid === null || paid !== decimalUnits(request.amount)) return `Valor pago difere do pedido (US$ ${request.amount}).`;
  if ((data.currency || 'USD') !== request.currency) return `Moeda difere do pedido (${request.currency}).`;
  return null;
}

// Payssion (https://www.payssion.com/en/docs/): página de pagamento hospedada, em que o cliente escolhe o meio
// (PIX, boleto, cartão). Assinaturas em MD5 com campos unidos por "|", conforme a documentação oficial:
// pedido hospedado = md5(api_key|amount|currency|order_id|secret_key);
// notificação      = md5(api_key|pm_id|amount|currency|order_id|state|secret_key).
const md5 = text => createHash('md5').update(text).digest('hex');
export function payssionConfig(env = process.env) {
  const apiKey = (env.PAYSSION_API_KEY || '').trim();
  const secretKey = (env.PAYSSION_SECRET_KEY || '').trim();
  if (!apiKey || !secretKey) return null;
  const sandbox = /^(1|true|sim|yes)$/i.test(env.PAYSSION_SANDBOX || '');
  return { apiKey, secretKey, sandbox, base: sandbox ? 'http://sandbox.payssion.com' : 'https://www.payssion.com' };
}
/** Valor no formato que vai assinado e enviado: duas casas decimais. */
export const payssionAmount = amount => (Number(decimalUnits(amount)) / 1e12).toFixed(2);
export function payssionCheckout(config, request, { returnUrl, payerEmail = '' } = {}) {
  const amount = payssionAmount(request.amount);
  const fields = {
    api_sig: md5([config.apiKey, amount, request.currency, request.id, config.secretKey].join('|')),
    order_id: request.id, amount, currency: request.currency,
    description: `Anubis Router - credito US$ ${amount}`,
    return_url: returnUrl,
  };
  if (payerEmail) fields.payer_email = payerEmail;
  return { provider: 'payssion', action: `${config.base}/checkout/${encodeURIComponent(config.apiKey)}`, method: 'POST', fields };
}
export function payssionNotifySignature(config, data) {
  return md5([config.apiKey, data.pm_id, data.amount, data.currency, data.order_id, data.state, config.secretKey].map(value => value ?? '').join('|'));
}
/**
 * Avalia uma notificação da Payssion. Só `completed` (ou `paid_more`) com o mesmo valor e moeda do pedido credita.
 * Devolve { error } para assinatura inválida, ou { approve, reason } para o servidor decidir.
 */
export function evaluatePayssionNotify(config, data, request) {
  if (!data || typeof data !== 'object') return { error: 'Notificação vazia.' };
  const expected = Buffer.from(payssionNotifySignature(config, data));
  const given = Buffer.from(String(data.notify_sig || '').toLowerCase());
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { error: 'Assinatura da Payssion inválida.' };
  if (!request) return { approve: false, reason: 'pedido_desconhecido' };
  if (!['completed', 'paid_more'].includes(data.state)) return { approve: false, reason: `estado_${data.state || 'vazio'}` };
  if (data.currency !== request.currency) return { approve: false, reason: 'moeda_divergente' };
  if (payssionAmount(data.amount) !== payssionAmount(request.amount)) return { approve: false, reason: 'valor_divergente' };
  return { approve: true, reason: null };
}

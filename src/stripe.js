// Stripe Checkout: página de pagamento hospedada (cartão e os meios ligados no painel da Stripe) e webhook assinado.
// Variáveis: STRIPE_SECRET_KEY (chave restrita rk_... só com "Checkout Sessions: Write") e STRIPE_WEBHOOK_SECRET (whsec_...).
// STRIPE_CURRENCY=brl cobra em reais (conta Stripe brasileira: cartão nacional e PIX); o saldo continua em dólar,
// convertido pela cotação do momento do checkout, que fica gravada no pedido para o webhook conferir.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 5 * 60;

export function stripeConfig(env = process.env) {
  const secretKey = (env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = (env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!/^(rk|sk)_(live|test)_/.test(secretKey) || !webhookSecret.startsWith('whsec_')) return null;
  const currency = String(env.STRIPE_CURRENCY || 'usd').trim().toLowerCase() === 'brl' ? 'brl' : 'usd';
  return { secretKey, webhookSecret, live: secretKey.includes('_live_'), currency };
}

/** Valor em centavos de dólar, sem arredondamento por ponto flutuante. */
export function stripeCents(amount) {
  const [whole, fraction = ''] = String(amount).split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}

/** Cria a Checkout Session e devolve { redirect } para a página hospedada da Stripe. */
export async function stripeCheckout(config, request, { returnUrl, fetcher = fetch, charge = null } = {}) {
  const cents = stripeCents(request.amount);
  // Cobrança em outra moeda (BRL): valor já convertido pelo servidor; sem ela, cobra os centavos de dólar do pedido.
  const currency = charge?.currency || 'usd';
  const unitAmount = charge?.amount ?? cents;
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][unit_amount]': String(unitAmount),
    'line_items[0][price_data][product_data][name]': `Anubis Router credit (US$ ${(cents / 100).toFixed(2)})`,
    client_reference_id: request.id,
    'metadata[orderId]': request.id,
    'payment_intent_data[metadata][orderId]': request.id,
    success_url: returnUrl,
    cancel_url: returnUrl,
  });
  const response = await fetcher('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      // Clique duplo não abre duas sessões. A chave inclui os parâmetros: a Stripe recusa (400) a mesma chave com
      // parâmetros diferentes, como outra URL de retorno.
      'idempotency-key': `anubis-${request.id}-${createHash('sha256').update(form.toString()).digest('hex').slice(0, 16)}`,
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.url !== 'string') throw new Error(`Stripe recusou o checkout (HTTP ${response.status}${payload?.error?.code ? `, ${payload.error.code}` : ''})`);
  return { provider: 'stripe', redirect: payload.url, checkoutId: payload.id || null };
}

/** Confere Stripe-Signature: t=<s>,v1=<hex>[,v1=...]; v1 = HMAC-SHA256("{t}.{corpo}") com o segredo whsec_. */
export function verifyStripeSignature(secret, raw, headers, now = Math.floor(Date.now() / 1000)) {
  const header = String(headers?.['stripe-signature'] || '');
  let timestamp = null; const signatures = [];
  for (const part of header.split(',')) {
    const index = part.indexOf('='); const name = part.slice(0, index).trim(); const value = part.slice(index + 1).trim();
    if (name === 't') timestamp = Number(value);
    if (name === 'v1') signatures.push(value);
  }
  if (!Number.isSafeInteger(timestamp) || !signatures.length) return 'Assinatura da Stripe ausente.';
  if (Math.abs(now - timestamp) > TOLERANCE_SECONDS) return 'Assinatura da Stripe vencida.';
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex'));
  const ok = signatures.some(given => { const value = Buffer.from(given.toLowerCase()); return value.length === expected.length && timingSafeEqual(value, expected); });
  return ok ? null : 'Assinatura da Stripe inválida.';
}

export const stripeOrderId = event => {
  const session = event?.data?.object;
  const id = session?.metadata?.orderId || session?.client_reference_id;
  return typeof id === 'string' ? id : null;
};

/**
 * Credita em checkout.session.completed já pago (cartão) ou em checkout.session.async_payment_succeeded (meios que
 * confirmam depois, como boleto). Valor e moeda precisam bater com o pedido.
 */
export function evaluateStripeNotify(config, event, request, { raw = '', headers = {}, now } = {}) {
  const invalid = verifyStripeSignature(config.webhookSecret, raw, headers, now);
  if (invalid) return { error: invalid };
  const session = event?.data?.object || {};
  const reference = String(session.payment_intent || session.id || event?.id || '').slice(0, 120);
  if (!request) return { approve: false, reason: 'pedido_desconhecido', reference };
  const paidNow = event.type === 'checkout.session.completed' && session.payment_status === 'paid';
  const paidLater = event.type === 'checkout.session.async_payment_succeeded';
  if (!paidNow && !paidLater) return { approve: false, reason: `evento_${event.type || 'vazio'}${session.payment_status ? `_${session.payment_status}` : ''}`, reference };
  // Vale a cobrança em dólar do pedido ou qualquer checkout em outra moeda aberto para ele (valor gravado no pedido).
  const currency = String(session.currency).toLowerCase();
  const charges = [{ currency: 'usd', amount: stripeCents(request.amount) }, ...(Array.isArray(request.charges) ? request.charges : [])];
  if (request.currency !== 'USD' || !charges.some(item => item.currency === currency)) return { approve: false, reason: 'moeda_divergente', reference };
  if (!charges.some(item => item.currency === currency && item.amount === session.amount_total)) return { approve: false, reason: 'valor_divergente', reference };
  return { approve: true, reason: null, reference, method: Array.isArray(session.payment_method_types) ? session.payment_method_types.join(',').slice(0, 40) : null };
}

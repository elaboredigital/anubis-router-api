// Gateways de pagamento das recargas. Cada gateway é um adaptador com a mesma interface; a API não depende de nenhum.
// PAYMENT_GATEWAYS define quais ficam ligados e em que ordem aparecem ao cliente (ex.: "mercadopago,payssion").
// Sem a variável, todos os gateways configurados ficam ligados, na ordem de ADAPTERS.
//
// Interface de um adaptador:
//   id, label, methods            identificação e meios mostrados ao cliente (ex.: PIX, boleto, cartão)
//   config(env)                   credenciais lidas das variáveis; null quando o gateway não está configurado
//   checkout(config, request, o)  cria o pagamento: { action, method, fields } (formulário) ou { redirect } (link)
//   orderId(data)                 ID do pedido de recarga dentro da notificação
//   evaluate(config, data, req, { raw, headers })  { error } para notificação inválida, ou { approve, reason, reference, method }
import { payssionConfig, payssionCheckout, evaluatePayssionNotify } from './credits.js';
import { coinbaseConfig, coinbaseCheckout, evaluateCoinbaseNotify } from './coinbase.js';
import { stripeConfig, stripeCheckout, stripeOrderId, evaluateStripeNotify } from './stripe.js';

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

export const ADAPTERS = Object.freeze({
  stripe: {
    id: 'stripe', label: 'Stripe', methods: ['Cartão'],
    config: env => stripeConfig(env),
    checkout: (config, request, options) => stripeCheckout(config, request, options),
    orderId: event => stripeOrderId(event),
    evaluate: (config, event, request, context) => evaluateStripeNotify(config, event, request, context),
  },
  coinbase: {
    id: 'coinbase', label: 'Coinbase (cripto)', methods: ['USDC'],
    config: env => coinbaseConfig(env),
    checkout: (config, request, options) => coinbaseCheckout(config, request, options),
    orderId: data => (typeof data?.metadata?.orderId === 'string' ? data.metadata.orderId : null),
    evaluate: (config, data, request, context) => evaluateCoinbaseNotify(config, data, request, context),
  },
  payssion: {
    id: 'payssion', label: 'Payssion', methods: ['PIX', 'Boleto', 'Cartão'],
    config: env => payssionConfig(env),
    async checkout(config, request, options) { return payssionCheckout(config, request, options); },
    orderId: data => (typeof data?.order_id === 'string' ? data.order_id : null),
    evaluate(config, data, request) {
      const verdict = evaluatePayssionNotify(config, data, request);
      return verdict.error ? verdict : { ...verdict, reference: clip(data.transaction_id, 120) || '', method: clip(data.pm_id, 40) };
    },
  },
});

/** Gateways ligados e configurados, na ordem de PAYMENT_GATEWAYS. */
export function activeGateways(env = process.env, adapters = ADAPTERS) {
  const order = (env.PAYMENT_GATEWAYS || Object.keys(adapters).join(',')).split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const id of [...new Set(order)]) {
    const adapter = adapters[id];
    if (!adapter) continue;
    const config = adapter.config(env);
    if (config) out.push({ adapter, config });
  }
  return out;
}
export const findGateway = (id, env = process.env, adapters = ADAPTERS) => activeGateways(env, adapters).find(item => item.adapter.id === id) || null;
/** O que o cliente vê: sem credenciais, só nome e meios de pagamento. */
// Stripe em reais (conta brasileira) também aceita PIX, e a cobrança sai em BRL pela cotação do dia.
export const publicGateways = (env = process.env, adapters = ADAPTERS) => activeGateways(env, adapters).map(({ adapter, config }) => {
  const brl = adapter.id === 'stripe' && config?.currency === 'brl';
  return { id: adapter.id, label: adapter.label, methods: brl ? ['Cartão', 'PIX'] : adapter.methods, chargeCurrency: brl ? 'BRL' : 'USD' };
});

/** Corpo da notificação em JSON ou formulário. */
export function parseNotification(raw, contentType = '') {
  return /^application\/json\b/i.test(contentType) ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
}

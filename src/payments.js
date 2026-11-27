// Gateways de pagamento das recargas. Cada gateway é um adaptador com a mesma interface; a API não depende de nenhum.
// PAYMENT_GATEWAYS define quais ficam ligados e em que ordem aparecem ao cliente (ex.: "mercadopago,payssion").
// Sem a variável, todos os gateways configurados ficam ligados, na ordem de ADAPTERS.
//
// Interface de um adaptador:
//   id, label, methods            identificação e meios mostrados ao cliente (ex.: PIX, boleto, cartão)
//   config(env)                   credenciais lidas das variáveis; null quando o gateway não está configurado
//   checkout(config, request, o)  cria o pagamento: { action, method, fields } (formulário) ou { redirect } (link)
//   orderId(data)                 ID do pedido de recarga dentro da notificação
//   evaluate(config, data, req)   { error } para notificação inválida, ou { approve, reason, reference, method }
import { payssionConfig, payssionCheckout, evaluatePayssionNotify } from './credits.js';

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

export const ADAPTERS = Object.freeze({
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
export const publicGateways = (env = process.env, adapters = ADAPTERS) => activeGateways(env, adapters).map(({ adapter }) => ({ id: adapter.id, label: adapter.label, methods: adapter.methods }));

/** Corpo da notificação em JSON ou formulário. */
export function parseNotification(raw, contentType = '') {
  return /^application\/json\b/i.test(contentType) ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
}

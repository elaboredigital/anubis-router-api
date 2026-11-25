// Snapshot dos preços públicos do MaxRouter. Nenhum desconto condicional é aplicado:
// a oferta pode expirar e o preço anunciado na API pública é a referência estável.
import { decimalUnits } from './dashboard.js';

export const MAXROUTER_PRICING_PAGE = 'https://www.maxrouter.ai/pricing';
export const MAXROUTER_PRICING_URL = 'https://www.maxrouter.ai/api/v1/models';

export function parseMaxRouterPrices(payload, capturedAt = new Date().toISOString()) {
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const at = !Number.isNaN(Date.parse(capturedAt)) ? new Date(capturedAt).toISOString() : new Date().toISOString();
  const prices = new Map();
  for (const item of items) {
    if (!item || item.status !== 'READY' || typeof item.slug !== 'string' || !/^[\w./:-]{1,160}$/.test(item.slug)) continue;
    if (decimalUnits(item.inputPrice) === null || decimalUnits(item.outputPrice) === null) continue;
    prices.set(item.slug, {
      currency: 'USD',
      unit: 'per_1m_tokens',
      tier: 'standard_context',
      input: item.inputPrice,
      output: item.outputPrice,
      source: MAXROUTER_PRICING_PAGE,
      sourceData: MAXROUTER_PRICING_URL,
      capturedAt: at,
    });
  }
  return prices;
}

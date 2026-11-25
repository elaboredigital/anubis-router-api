// Catálogo público de modelos para o painel do cliente.
// Expõe apenas preço de VENDA (multiplicador ou preço manual), nunca custo do fornecedor, conexão ou credencial.
import { decimalUnits, formatUnits } from './dashboard.js';

const SCALE = 10n ** 12n;
const HOUR = 3600_000;
export const UPTIME_BUCKETS = 24;

/** Família exibida nas abas: deduzida do ID/nome, porque o campo do fornecedor nem sempre representa o criador. */
const FAMILIES = [
  ['anthropic', /claude|anthropic/i], ['openai', /\bgpt|\bo[134]\b|o[134]-|codex|openai|chatgpt/i], ['google', /gemini|gemma|google/i],
  ['deepseek', /deepseek/i], ['qwen', /qwen|qwq/i], ['moonshot', /kimi|moonshot/i], ['zai', /glm|zhipu|z\.ai/i],
  ['minimax', /minimax/i], ['xai', /grok|x-ai|xai/i], ['meta', /llama|meta/i], ['mistral', /mistral|mixtral|codestral|devstral|magistral|ministral/i],
  ['xiaomi', /mimo|xiaomi/i], ['inception', /mercury|inception/i], ['agnes', /agnes/i],
];
export function modelFamily(id, name = '') {
  const text = `${id} ${name}`;
  return FAMILIES.find(([, pattern]) => pattern.test(text))?.[0] || 'other';
}

function scaled(value, multiplierUnits) {
  const units = decimalUnits(value === null || value === undefined ? null : String(value));
  if (units === null) return null;
  return formatUnits(multiplierUnits === null ? units : units * multiplierUnits / SCALE);
}

/** Preço de venda por campo. Preço manual prevalece; sem preço manual, custo × multiplicador. */
export function salePrice(costSnapshot, resolved) {
  const manual = resolved?.manualPrice;
  if (manual && typeof manual === 'object') {
    const perRequest = manual.basis === 'per_request';
    return {
      billingType: perRequest ? 'request' : 'token', currency: manual.currency || 'USD',
      request: perRequest ? scaled(manual.request, null) : null,
      input: perRequest ? null : scaled(manual.input, null), output: perRequest ? null : scaled(manual.output, null),
      cacheRead: scaled(manual.cacheRead, null), cacheWrite: scaled(manual.cacheWrite, null),
    };
  }
  if (!costSnapshot) return null;
  const multiplierUnits = decimalUnits(String(resolved?.multiplier || '5'));
  if (multiplierUnits === null) return null;
  const perRequest = costSnapshot.billingType === 'request';
  const price = {
    billingType: perRequest ? 'request' : 'token', currency: costSnapshot.currency || 'USD',
    request: perRequest ? scaled(costSnapshot.request, multiplierUnits) : null,
    input: perRequest ? null : scaled(costSnapshot.input, multiplierUnits),
    output: perRequest ? null : scaled(costSnapshot.output, multiplierUnits),
    cacheRead: scaled(costSnapshot.cacheRead, multiplierUnits), cacheWrite: scaled(costSnapshot.cacheWrite, multiplierUnits),
  };
  const hasPrice = perRequest ? price.request !== null : price.input !== null || price.output !== null;
  return hasPrice ? price : null;
}

/**
 * Disponibilidade por hora nas últimas 24h, pelo desfecho final de cada requisição:
 * concluída conta como sucesso; falha conta como erro; cancelada ou pendente não entra.
 */
export function uptimeFor(records, model, now = Date.now()) {
  const start = Math.floor(now / HOUR) * HOUR - (UPTIME_BUCKETS - 1) * HOUR;
  const finals = new Map();
  let cached = 0; let input = 0;
  for (const record of records) {
    if (record.publicModel !== model) continue;
    const at = Date.parse(record.startedAt);
    if (!(at >= start) || at > now) continue;
    const key = record.requestId || record.id;
    const previous = finals.get(key);
    const outcome = record.status === 'completed' ? 'ok' : ['cancelled', 'pending'].includes(record.status) ? null : 'fail';
    if (!previous || outcome === 'ok' || (previous.outcome === null && outcome)) finals.set(key, { at: previous?.at ?? at, outcome });
    if (record.status === 'completed') {
      cached += record.usage?.cachedInputTokens || 0;
      input += record.usage?.inputTokens || 0;
    }
  }
  const timeline = Array.from({ length: UPTIME_BUCKETS }, () => ({ ok: 0, fail: 0 }));
  for (const { at, outcome } of finals.values()) {
    if (!outcome) continue;
    const bucket = Math.min(UPTIME_BUCKETS - 1, Math.floor((at - start) / HOUR));
    timeline[bucket][outcome]++;
  }
  const ok = timeline.reduce((sum, b) => sum + b.ok, 0); const fail = timeline.reduce((sum, b) => sum + b.fail, 0);
  return {
    uptime: ok + fail ? Math.round(ok / (ok + fail) * 10000) / 100 : null,
    cacheHitRate: input ? Math.round(cached / input * 10000) / 100 : null,
    requests: ok + fail,
    timeline: timeline.map(b => b.ok + b.fail ? Math.round(b.ok / (b.ok + b.fail) * 10000) / 100 : null),
  };
}

/**
 * Lista pública: um item por ID público habilitado, com preço da rota de maior prioridade.
 * `resolve(provider, upstreamModel)` devolve { multiplier, manualPrice } vigentes.
 */
export function buildPublicCatalog({ routes, connectionForRoute, resolve, records = [], now = Date.now() }) {
  const byId = new Map();
  const ordered = routes.filter(r => r.enabled && connectionForRoute(r))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  for (const route of ordered) {
    if (byId.has(route.id)) continue;
    const connection = connectionForRoute(route);
    const providerModel = connection.models?.find(m => m.id === route.upstreamModel) || null;
    const pricing = providerModel?.pricing || null;
    const cost = pricing ? {
      billingType: providerModel.billingType, currency: pricing.currency || 'USD',
      request: pricing.request ?? null, input: pricing.input ?? null, output: pricing.output ?? null,
      cacheRead: pricing.cacheRead ?? pricing.cache_read ?? null, cacheWrite: pricing.cacheWrite ?? pricing.cache_write ?? null,
    } : null;
    const name = route.name || providerModel?.name || route.id;
    byId.set(route.id, {
      id: route.id, name,
      family: modelFamily(route.id, name),
      planOnly: !!providerModel?.planOnly,
      context: providerModel?.context || null,
      price: salePrice(cost, resolve(connection.provider, route.upstreamModel)),
      createdAt: route.createdAt || null,
      ...uptimeFor(records, route.id, now),
    });
  }
  return [...byId.values()];
}

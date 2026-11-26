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

const PRICE_FIELDS = ['request', 'input', 'output', 'cacheRead', 'cacheWrite'];

/** Custo cobrado pelo fornecedor nesta rota, ou null quando a conexão não publica preço. */
export function routeCost(connection, route) {
  const providerModel = connection?.models?.find(m => m.id === route.upstreamModel) || null;
  const pricing = providerModel?.pricing || null;
  if (!pricing) return null;
  return {
    billingType: providerModel.billingType === 'request' ? 'request' : 'token', currency: pricing.currency || 'USD',
    request: pricing.request ?? null, input: pricing.input ?? null, output: pricing.output ?? null,
    cacheRead: pricing.cacheRead ?? pricing.cache_read ?? null, cacheWrite: pricing.cacheWrite ?? pricing.cache_write ?? null,
    planOnly: !!providerModel.planOnly,
  };
}

/**
 * Custo de referência do modelo: média, campo a campo, entre os fornecedores que cobram na mesma unidade e moeda.
 * Prevalece o grupo com mais fornecedores; no empate, o do fornecedor de maior prioridade (primeiro da lista).
 */
export function averageCost(costs) {
  const groups = new Map();
  for (const cost of costs) {
    if (!cost) continue;
    const key = `${cost.billingType}\u0000${cost.currency}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cost);
  }
  let chosen = null;
  for (const group of groups.values()) if (!chosen || group.length > chosen.length) chosen = group;
  if (!chosen) return null;
  const average = { billingType: chosen[0].billingType, currency: chosen[0].currency, suppliers: chosen.length };
  for (const field of PRICE_FIELDS) {
    const values = chosen.map(cost => decimalUnits(cost[field] === null || cost[field] === undefined ? null : String(cost[field]))).filter(units => units !== null);
    average[field] = values.length ? formatUnits(values.reduce((sum, units) => sum + units, 0n) / BigInt(values.length)) : null;
  }
  return average;
}

/** Desconto inteiro sobre o preço original, só quando a venda é menor. */
function discount(original, sale) {
  const before = Number(original); const after = Number(sale);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0 || after >= before) return null;
  return Math.round((1 - after / before) * 100);
}

/**
 * Preço de cada ID público: fornecedores ativos, custo médio, regra vigente e preço de venda.
 * A regra (multiplicador ou preço manual) é a do fornecedor de maior prioridade.
 * `resolve(provider, upstreamModel)` devolve { multiplier, manualPrice, versionIds }.
 */
export function modelPricing({ routes, connectionForRoute, resolve, originals = {} }) {
  const byId = new Map();
  const ordered = routes.filter(r => r.enabled && connectionForRoute(r))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  for (const route of ordered) {
    const connection = connectionForRoute(route);
    if (!byId.has(route.id)) byId.set(route.id, { id: route.id, route, connection, suppliers: [] });
    byId.get(route.id).suppliers.push({
      connectionId: connection.id || null, connectionName: connection.name || connection.provider, provider: connection.provider,
      upstreamModel: route.upstreamModel, priority: route.priority ?? 100, cost: routeCost(connection, route),
    });
  }
  return [...byId.values()].map(item => {
    const { route, connection } = item;
    const providerModel = connection.models?.find(m => m.id === route.upstreamModel) || null;
    const reference = averageCost(item.suppliers.map(s => s.cost));
    const resolved = resolve(connection.provider, route.upstreamModel) || {};
    return {
      id: item.id, route, providerModel, suppliers: item.suppliers, referenceCost: reference, resolved,
      sale: salePrice(reference, resolved), original: originals[item.id] || null,
    };
  });
}

/** Preço original público com o desconto de cada campo em relação à venda. */
function publicOriginal(original, sale) {
  if (!original || !sale) return null;
  const out = { currency: original.currency || 'USD' };
  let any = false;
  for (const field of PRICE_FIELDS) {
    const value = original[field];
    out[field] = value === undefined || value === '' ? null : value;
    if (out[field] !== null) any = true;
  }
  if (!any) return null;
  out.discount = Object.fromEntries(PRICE_FIELDS.map(field => [field, out[field] === null || sale[field] === null ? null : discount(out[field], sale[field])]));
  return out;
}

/**
 * Lista pública: um item por ID público habilitado, com preço de venda (média de custo × multiplicador)
 * e preço original do fabricante quando cadastrado. Nunca expõe custo, fornecedor ou conexão.
 */
export function buildPublicCatalog({ routes, connectionForRoute, resolve, originals = {}, records = [], now = Date.now() }) {
  return modelPricing({ routes, connectionForRoute, resolve, originals }).map(item => {
    const name = item.route.name || item.providerModel?.name || item.id;
    return {
      id: item.id, name,
      family: modelFamily(item.id, name),
      planOnly: !!item.providerModel?.planOnly,
      context: item.providerModel?.context || null,
      price: item.sale,
      originalPrice: publicOriginal(item.original, item.sale),
      createdAt: item.route.createdAt || null,
      ...uptimeFor(records, item.id, now),
    };
  });
}

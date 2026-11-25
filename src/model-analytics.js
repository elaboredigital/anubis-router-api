// Financeiro por modelo: usa o custo capturado na chamada e o lucro já liquidado na razão.
// Nenhuma moeda é convertida, nenhum preço é inventado e nenhuma chave completa sai daqui.
import { decimalUnits, formatUnits, recordCost } from './dashboard.js';
import { parsePeriod } from './reconciliation.js';
import { rangeFor, inside, tokensOf, addSale, formatTotals, groupRequests } from './client-stats.js';

const CURRENCY = /^[A-Z]{3}$/;
const MODEL_ID = /^[\w./:-]{1,160}$/;
const list = value => Array.isArray(value) ? value : [];
const masked = key => key?.prefix ? `${key.prefix}••••••••` : 'sk-••••••••';

function addUnits(map, currency, units) {
  if (!CURRENCY.test(currency || '') || typeof units !== 'bigint') return;
  map.set(currency, (map.get(currency) || 0n) + units);
}
function addCost(map, cost) {
  if (cost && CURRENCY.test(cost.currency || '')) addUnits(map, cost.currency, cost.units);
}
function bucket(fields = {}) {
  return {
    requests: 0, observed: 0, completed: 0, failed: 0, cancelled: 0, pending: 0,
    tokens: 0, unpriced: 0, lastAt: null, keys: new Set(),
    cost: new Map(), spend: new Map(), profit: new Map(), ...fields,
  };
}
function latestEntries(entries) {
  const byRequest = new Map();
  for (const entry of list(entries)) {
    if (!entry?.requestId) continue;
    const current = byRequest.get(entry.requestId);
    const stamp = String(entry.createdAt || entry.at || entry.startedAt || '');
    if (!current || stamp >= String(current.createdAt || current.at || current.startedAt || '')) byRequest.set(entry.requestId, entry);
  }
  return byRequest;
}
function marginRows(spend, profit) {
  return [...new Set([...spend.keys(), ...profit.keys()])].sort().map(currency => {
    const sale = spend.get(currency) || 0n;
    const gain = profit.get(currency) || 0n;
    return {
      currency,
      amount: formatUnits(gain),
      marginPercent: sale > 0n ? Math.round(Number(gain * 10000n / sale)) / 100 : null,
    };
  });
}
function finish(item) {
  return {
    model: item.model, label: item.label || String(item.model || '').split('/').at(-1) || 'modelo',
    requests: item.requests, observed: item.observed, completed: item.completed,
    failed: item.failed, cancelled: item.cancelled, pending: item.pending,
    tokens: item.tokens, keys: item.keys.size, unpriced: item.unpriced, lastAt: item.lastAt,
    providers: [...(item.providers || [])].sort(),
    upstreamModels: [...(item.upstreamModels || [])].sort(),
    routes: item.routes || 0, enabledRoutes: item.enabledRoutes || 0,
    cost: formatTotals(item.cost), spend: formatTotals(item.spend), profit: formatTotals(item.profit),
    margin: marginRows(item.spend, item.profit),
  };
}
function metaFor(routes, connections) {
  const meta = new Map();
  for (const route of list(routes)) {
    if (!MODEL_ID.test(route?.id || '')) continue;
    const item = meta.get(route.id) || {
      model: route.id, providers: new Set(), upstreamModels: new Set(), routes: 0, enabledRoutes: 0,
    };
    const connection = connections.find(entry => entry?.id === route.connectionId);
    if (route.provider || connection?.provider) item.providers.add(route.provider || connection.provider);
    if (route.upstreamModel) item.upstreamModels.add(route.upstreamModel);
    item.routes++;
    if (route.enabled !== false) item.enabledRoutes++;
    meta.set(route.id, item);
  }
  return meta;
}

/** Resumo por modelo e, quando `model` é informado, o detalhe por chave com gastos liquidados. */
export function buildModelAnalytics({
  keys = [], plans = [], records = [], entries = [], routes = [], connections = [],
  admin = {}, period = {}, model = null, now = new Date().toISOString(),
} = {}) {
  const parsed = parsePeriod(period);
  if (parsed.error) return { error: parsed.error };
  const range = rangeFor(parsed, now);
  if (range.error) return { error: range.error };

  const wanted = typeof model === 'string' && model.trim() ? model.trim() : null;
  if (wanted && !MODEL_ID.test(wanted)) return { error: 'Modelo inválido.' };

  const keyList = list(keys);
  const planList = list(plans);
  const connectionList = list(connections);
  const meta = metaFor(routes, connectionList);
  const byRequest = latestEntries(entries);
  const totals = bucket({ model: 'total' });
  const byModel = new Map();
  const byKey = new Map();

  for (const group of groupRequests(list(records).filter(record => inside(record, range)))) {
    const record = group.final;
    const modelId = record?.publicModel || record?.upstreamModel || 'modelo';
    const modelItem = byModel.get(modelId) || bucket({
      model: modelId,
      label: meta.get(modelId)?.label || String(modelId).split('/').at(-1),
      providers: new Set(meta.get(modelId)?.providers || []),
      upstreamModels: new Set(meta.get(modelId)?.upstreamModels || []),
      routes: meta.get(modelId)?.routes || 0,
      enabledRoutes: meta.get(modelId)?.enabledRoutes || 0,
    });
    byModel.set(modelId, modelItem);
    for (const item of [totals, modelItem]) {
      item.observed++;
      item[group.status]++;
    }
    if (group.status !== 'completed') continue;

    const keyId = record.clientKeyId || 'sem-chave';
    const key = keyList.find(item => item?.id === keyId) || null;
    const plan = key ? planList.find(item => item?.id === key.planId) || null : null;
    const keyItemId = `${modelId}\u0000${keyId}`;
    const keyItem = byKey.get(keyItemId) || bucket({
      model: modelId, keyId, name: key?.name || 'Chave removida', label: masked(key),
      active: key?.active !== false, planName: plan?.name || 'Sem plano',
    });
    byKey.set(keyItemId, keyItem);

    const tokens = tokensOf(record);
    const at = record.finishedAt || record.startedAt || null;
    if (record.provider) modelItem.providers.add(record.provider);
    if (record.upstreamModel) modelItem.upstreamModels.add(record.upstreamModel);
    for (const item of [totals, modelItem, keyItem]) {
      item.requests++;
      item.tokens += tokens;
      item.keys.add(keyId);
      if (at && (!item.lastAt || at > item.lastAt)) item.lastAt = at;
    }

    const cost = recordCost(record);
    if (cost) for (const item of [totals, modelItem, keyItem]) addCost(item.cost, cost);
    const entry = byRequest.get(group.id);
    if (entry?.status === 'settled' && entry.sale !== null && entry.sale !== undefined) {
      for (const item of [totals, modelItem, keyItem]) addSale(item.spend, entry);
    } else {
      for (const item of [totals, modelItem, keyItem]) item.unpriced++;
    }
    if (entry?.status === 'settled' && entry.saleCurrency === entry.currency) {
      const margin = decimalUnits(entry.margin);
      if (margin !== null) for (const item of [totals, modelItem, keyItem]) addUnits(item.profit, entry.currency, margin);
    }
  }

  const models = [...byModel.values()]
    .sort((a, b) => b.requests - a.requests || String(a.model).localeCompare(String(b.model)))
    .map(finish);
  const common = {
    period: { from: range.start, to: range.end, clamped: range.clamped },
    admin: {
      configured: admin.configured === true,
      clientSessions: Number.isSafeInteger(admin.clientSessions) ? admin.clientSessions : 0,
      keys: keyList.length,
      activeKeys: keyList.filter(key => key.active !== false).length,
    },
    scope: 'last_10000_requests', generatedAt: now,
  };

  if (!wanted) return { ...common, totals: finish(totals), models };

  const selected = models.find(item => item.model === wanted || item.upstreamModels.includes(wanted));
  if (!selected) return { ...common, error: 'Modelo sem dados no período.', missing: true, model: { model: wanted, label: wanted } };
  const users = [...byKey.values()].filter(item => item.model === selected.model)
    .sort((a, b) => b.requests - a.requests || String(a.keyId).localeCompare(String(b.keyId)))
    .map(item => ({
      ...finish(item),
      name: item.name, label: item.label, keyId: item.keyId,
      active: item.active, planName: item.planName,
    }));
  return {
    ...common,
    model: {
      ...selected,
      aliases: [...new Set([selected.model, ...selected.upstreamModels])].sort(),
      users,
    },
  };
}

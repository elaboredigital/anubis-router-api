// Visão global do administrador: agrega as mesmas requisições deduplicadas das estatísticas por chave.
// Nenhuma moeda é convertida, nenhum valor é inferido sem snapshot e nenhum segredo sai daqui.
import { decimalUnits, formatUnits, recordCost } from './dashboard.js';
import { parsePeriod } from './reconciliation.js';
import { buildWallets } from './topup.js';
import { rangeFor, datesIn, inside, tokensOf, addSale, formatTotals, emptyDay, groupRequests } from './client-stats.js';

const CURRENCY = /^[A-Z]{3}$/;
const TOP = 10;
const list = value => Array.isArray(value) ? value : [];
const dayOf = record => String(record?.startedAt || record?.finishedAt || '').slice(0, 10);
const masked = key => key?.prefix ? `${key.prefix}••••••••` : 'sk-••••••••';

function addCost(map, cost) {
  if (!cost || !CURRENCY.test(cost.currency || '')) return;
  map.set(cost.currency, (map.get(cost.currency) || 0n) + cost.units);
}
function addUnits(map, currency, units) {
  if (!CURRENCY.test(currency || '') || typeof units !== 'bigint') return;
  map.set(currency, (map.get(currency) || 0n) + units);
}
function isFailure(record) {
  return record?.status === 'upstream_error' || record?.status === 'upstream_unknown';
}
function failureRow(record) {
  const failure = record?.failure && typeof record.failure === 'object' ? record.failure : {};
  return {
    at: record.finishedAt || record.startedAt || null,
    requestId: record.requestId || null,
    attempt: Number.isSafeInteger(record.attempt) ? record.attempt : null,
    destinationId: record.destinationId || null,
    provider: record.provider || null,
    connectionId: record.connectionId || null,
    model: record.publicModel || record.upstreamModel || null,
    httpStatus: Number.isSafeInteger(record.httpStatus) ? record.httpStatus : null,
    stage: typeof failure.stage === 'string' ? failure.stage : 'gateway',
    reason: typeof failure.reason === 'string' ? failure.reason : 'falha_sem_metadado',
    retryable: failure.retryable === true,
  };
}
function bucketFor(map, id, fields = {}) {
  let item = map.get(id);
  if (!item) {
    item = { id, requests: 0, tokens: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, unpriced: 0, spend: new Map(), cost: new Map(), profit: new Map(), ...fields };
    map.set(id, item);
  }
  return item;
}
function finishList(map, limit = TOP) {
  return [...map.values()]
    .sort((a, b) => b.requests - a.requests || b.tokens - a.tokens || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit)
    .map(item => ({ ...item, spend: formatTotals(item.spend || new Map()), cost: formatTotals(item.cost || new Map()), profit: formatTotals(item.profit || new Map()) }));
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

/** Agregados globais: chaves, planos, modelos, provedores, conexões, carteiras e série diária. */
export function buildGlobalStats({
  keys = [], plans = [], records = [], entries = [], topups = [], connections = [],
  admin = {}, period = {}, now = new Date().toISOString(),
} = {}) {
  const parsed = parsePeriod(period);
  if (parsed.error) return { error: parsed.error };
  const range = rangeFor(parsed, now);
  if (range.error) return { error: range.error };

  const keyList = list(keys);
  const planList = list(plans);
  const connectionList = list(connections);
  const days = new Map(datesIn(range).map(date => [date, { ...emptyDay(date), cost: new Map() }]));
  const relevant = list(records).filter(record => inside(record, range));
  const groups = groupRequests(relevant);
  const byRequest = latestEntries(entries);

  const totals = {
    observed: groups.length, records: relevant.length, completed: 0, failed: 0, cancelled: 0, pending: 0,
    requests: 0, tokens: 0, unpriced: 0, spend: new Map(), cost: new Map(), profit: new Map(),
  };
  const byKey = new Map(); const byModel = new Map(); const byProvider = new Map(); const byConnection = new Map();

  for (const group of groups) {
    const record = group.final;
    const status = group.status;
    const day = days.get(dayOf(record));
    totals[status]++;
    if (day) day[status]++;
    if (status !== 'completed') continue;

    const tokens = tokensOf(record);
    const model = record.publicModel || record.upstreamModel || 'modelo';
    const provider = record.provider || 'fornecedor';
    const connectionId = record.connectionId || null;
    const key = keyList.find(item => item?.id === record.clientKeyId) || null;
    const plan = key ? planList.find(item => item?.id === key.planId) || null : null;
    const connection = connectionList.find(item => item?.id === connectionId) || null;
    const entry = byRequest.get(group.id);
    const cost = recordCost(record);

    totals.requests++; totals.tokens += tokens;
    if (day) { day.requests++; day.tokens += tokens; }
    const targets = [
      bucketFor(byKey, record.clientKeyId || 'sem-chave', { name: key?.name || 'Chave removida', label: masked(key), active: key?.active !== false, planName: plan?.name || 'Sem plano' }),
      bucketFor(byModel, model),
      bucketFor(byProvider, provider),
      bucketFor(byConnection, connectionId || provider, { provider, name: connection?.name || 'sem credencial informada', connectionId }),
    ];
    for (const item of targets) { item.requests++; item.tokens += tokens; item[status]++; }

    if (entry?.status === 'settled' && entry.sale !== null && entry.sale !== undefined) {
      for (const item of [totals, ...targets]) addSale(item.spend, entry);
    } else totals.unpriced++;
    // Lucro simulado somente quando custo e venda estão liquidados na mesma moeda; nunca converte.
    if (entry?.status === 'settled' && entry.saleCurrency === entry.currency) {
      const margin = decimalUnits(entry.margin);
      if (margin !== null) for (const item of [totals, ...targets]) addUnits(item.profit, entry.currency, margin);
    }
    if (cost) {
      for (const item of [totals, ...targets]) addCost(item.cost, cost);
      if (day) addCost(day.cost, cost);
    }
  }

  const wallets = buildWallets(keyList, planList, topups, entries);
  const walletTotals = new Map();
  const walletRows = wallets.map(wallet => {
    // buildWallets devolve valores ja formatados; converte de volta para somar sem perder precisao.
    const credits = decimalUnits(wallet.credits) ?? 0n;
    const consumed = decimalUnits(wallet.consumed) ?? 0n;
    const balance = credits - consumed;
    const aggregate = walletTotals.get(wallet.currency) || { creditUnits: 0n, debitUnits: 0n, keys: 0 };
    aggregate.creditUnits += credits; aggregate.debitUnits += consumed; aggregate.keys++;
    walletTotals.set(wallet.currency, aggregate);
    const key = keyList.find(item => item?.id === wallet.keyId);
    return {
      keyId: wallet.keyId, keyName: wallet.keyName, label: masked(key),
      planName: wallet.planName, currency: wallet.currency,
      credits: wallet.credits, consumed: wallet.consumed,
      balance: formatUnits(balance), negative: balance < 0n,
      requests: wallet.requests, pending: wallet.pending,
    };
  });

  const planRows = planList.map(plan => ({
    planId: plan.id, name: plan.name || 'Sem nome', kind: plan.kind || 'free',
    active: plan.active !== false, keys: keyList.filter(key => key.planId === plan.id).length,
  })).sort((a, b) => b.keys - a.keys || String(a.name).localeCompare(String(b.name)));

  const failureAttempts = relevant.filter(isFailure).map(failureRow);
  const countBy = field => failureAttempts.reduce((map, row) => {
    const key = row[field] || 'sem-informacao';
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map());
  const failures = {
    attempts: failureAttempts.length,
    requests: new Set(failureAttempts.map(row => row.requestId).filter(Boolean)).size,
    byStage: Object.fromEntries(countBy('stage')),
    byReason: Object.fromEntries(countBy('reason')),
    byProvider: Object.fromEntries(countBy('provider')),
    recent: failureAttempts.slice(0, 20),
  };
  const failureRate = totals.observed ? Math.round(totals.failed * 10000 / totals.observed) / 100 : 0;
  const activeInPeriod = new Set(groups.filter(group => group.status === 'completed').map(group => group.final.clientKeyId).filter(Boolean)).size;
  const activeConnections = connectionList.filter(item => item.active !== false).length;
  const providerRows = [...byConnection.values()].reduce((map, item) => {
    const row = map.get(item.provider) || { id: item.provider, requests: 0, tokens: 0, connections: 0, spend: new Map(), cost: new Map(), profit: new Map() };
    row.requests += item.requests; row.tokens += item.tokens; row.connections++;
    for (const [currency, units] of item.spend) row.spend.set(currency, (row.spend.get(currency) || 0n) + units);
    for (const [currency, units] of item.cost) row.cost.set(currency, (row.cost.get(currency) || 0n) + units);
    for (const [currency, units] of item.profit) row.profit.set(currency, (row.profit.get(currency) || 0n) + units);
    map.set(item.provider, row);
    return map;
  }, new Map());

  return {
    period: { from: range.start, to: range.end, clamped: range.clamped },
    totals: { ...totals, spend: formatTotals(totals.spend), cost: formatTotals(totals.cost), profit: formatTotals(totals.profit) },
    byStatus: { completed: totals.completed, failed: totals.failed, cancelled: totals.cancelled, pending: totals.pending },
    failureRate,
    admin: { configured: admin.configured === true, clientSessions: Number.isSafeInteger(admin.clientSessions) ? admin.clientSessions : 0 },
    users: {
      total: keyList.length,
      active: keyList.filter(key => key.active !== false).length,
      activeInPeriod,
      withActivityInPeriod: new Set(relevant.map(record => record.clientKeyId).filter(Boolean)).size,
    },
    failures,
    keys: {
      total: keyList.length, active: keyList.filter(key => key.active !== false).length,
      activeInPeriod,
      revoked: keyList.filter(key => key.active === false).length,
      withPlan: keyList.filter(key => !!key.planId).length,
      top: finishList(byKey),
    },
    plans: planRows,
    connections: { total: connectionList.length, active: activeConnections, byProvider: finishList(providerRows) },
    models: finishList(byModel),
    providers: finishList(byProvider),
    wallets: {
      byKey: walletRows.sort((a, b) => b.keyId.localeCompare(a.keyId)),
      byCurrency: [...walletTotals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, item]) => ({
        currency, keys: item.keys,
        credits: formatUnits(item.creditUnits), consumed: formatUnits(item.debitUnits),
        balance: formatUnits(item.creditUnits - item.debitUnits),
      })),
    },
    series: [...days.values()].map(item => ({ ...item, spend: formatTotals(item.spend), cost: formatTotals(item.cost) })),
    scope: 'last_10000_requests', generatedAt: now,
  };
}

// Estatísticas da home do cliente: apenas a chave autenticada, requisições concluídas e valores já liquidados.
import { decimalUnits, formatUnits } from './dashboard.js';
import { parsePeriod } from './reconciliation.js';

const DAY_MS = 86400000;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_DAYS = 366;
const list = value => Array.isArray(value) ? value : [];

export function rangeFor({ from, to }, now) {
  const end = to || new Date(now).toISOString();
  let start = from || new Date(Date.parse(end) - 30 * DAY_MS).toISOString();
  let clamped = false;
  if ((Date.parse(end) - Date.parse(start)) / DAY_MS > MAX_DAYS) {
    start = new Date(Date.parse(end) - (MAX_DAYS - 1) * DAY_MS).toISOString();
    clamped = true;
  }
  if (Date.parse(start) >= Date.parse(end)) return { error: 'Período inválido: o início deve ser anterior ao fim.' };
  return { start, end, clamped };
}

/** Datas UTC do primeiro ao último dia com instantes dentro do período (fim exclusivo). */
export function datesIn(range) {
  const last = new Date(Date.parse(range.end) - 1).toISOString().slice(0, 10);
  const dates = [];
  for (let time = Date.parse(`${range.start.slice(0, 10)}T00:00:00.000Z`); dates.length < MAX_DAYS; time += DAY_MS) {
    const date = new Date(time).toISOString().slice(0, 10);
    dates.push(date);
    if (date >= last) break;
  }
  return dates;
}
export function inside(record, range) {
  const at = record?.startedAt || record?.finishedAt;
  return typeof at === 'string' && at >= range.start && at < range.end;
}
function dayOf(record) { return (record.startedAt || record.finishedAt || '').slice(0, 10); }
export function tokensOf(record) {
  let tokens = 0;
  for (const field of ['inputTokens', 'outputTokens']) {
    const value = record?.usage?.[field];
    if (Number.isSafeInteger(value) && value >= 0) tokens += value;
  }
  return tokens;
}
function currencyOf(entry) {
  const value = entry?.saleCurrency || entry?.currency;
  return CURRENCY.test(value || '') ? value : null;
}
export function addSale(map, entry) {
  if (entry?.status !== 'settled' || entry.sale === null || entry.sale === undefined) return;
  const currency = currencyOf(entry);
  const units = currency ? decimalUnits(entry.sale) : null;
  if (!currency || units === null) return;
  map.set(currency, (map.get(currency) || 0n) + units);
}
export function formatTotals(map) {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, units]) => ({ currency, amount: formatUnits(units) }));
}
export function emptyDay(date) { return { date, requests: 0, tokens: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, spend: new Map() }; }
function finish(map) {
  return [...map.values()]
    .sort((a, b) => b.requests - a.requests || String(a.model || a.provider).localeCompare(String(b.model || b.provider)))
    .map(item => ({ ...item, spend: formatTotals(item.spend) }));
}

const STATUS_RANK = { completed: 4, pending: 3, cancelled: 2, failed: 1 };
const DETAIL_LIMIT = 200;
const COST_FIELDS = ['currency', 'unit', 'request', 'input', 'output', 'cache_read', 'cache_write', 'cacheRead', 'cacheWrite'];
function statusOf(record) {
  if (record?.status === 'completed') return 'completed';
  if (record?.status === 'cancelled') return 'cancelled';
  if (record?.status === 'pending') return 'pending';
  return 'failed';
}
function safeFields(value, fields) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const field of fields) if (typeof value[field] === 'string' || typeof value[field] === 'number') result[field] = value[field];
  return Object.keys(result).length ? result : null;
}
function duration(record) {
  const start = Date.parse(record?.startedAt), end = Date.parse(record?.finishedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}
function safeAttempt(record) {
  return {
    attempt: Number.isSafeInteger(record?.attempt) && record.attempt > 0 ? record.attempt : null,
    status: statusOf(record),
    rawStatus: typeof record?.status === 'string' ? record.status : null,
    httpStatus: Number.isSafeInteger(record?.httpStatus) ? record.httpStatus : null,
    startedAt: typeof record?.startedAt === 'string' ? record.startedAt : null,
    finishedAt: typeof record?.finishedAt === 'string' ? record.finishedAt : null,
    durationMs: duration(record),
    model: record?.publicModel || record?.upstreamModel || null,
    provider: record?.provider || null,
    connectionId: record?.connectionId || null,
    destinationId: record?.destinationId || null,
    endpoint: record?.endpoint || null,
    tokens: tokensOf(record),
    cost: safeFields(record?.costSnapshot, COST_FIELDS),
    multiplier: safeFields(record?.saleSnapshot, ['multiplier'])?.multiplier ?? null,
  };
}
function safeBilling(entry) {
  if (!entry) return null;
  const sale = typeof entry.sale === 'string' || typeof entry.sale === 'number' ? entry.sale : null;
  const cost = typeof entry.cost === 'string' || typeof entry.cost === 'number' ? entry.cost : null;
  return { status: typeof entry.status === 'string' ? entry.status : null, sale, cost, currency: currencyOf(entry) };
}
export function groupRequests(records) {
  const groups = new Map();
  for (const record of records) {
    const id = record?.requestId || record?.id || null;
    const key = id || `sem-id-${groups.size}`;
    if (!groups.has(key)) groups.set(key, { id, attempts: [] });
    groups.get(key).attempts.push(record);
  }
  return [...groups.values()].map(group => {
    const attempts = [...group.attempts].sort((a, b) => (Number(a.attempt) || 0) - (Number(b.attempt) || 0) || String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
    let final = attempts[0];
    for (const item of attempts) if (STATUS_RANK[statusOf(item)] > STATUS_RANK[statusOf(final)]) final = item;
    return { id: group.id, attempts, final, status: statusOf(final) };
  });
}
function safeRequest(group, billing) {
  const final = group.final;
  return {
    requestId: group.id,
    status: group.status,
    startedAt: typeof final.startedAt === 'string' ? final.startedAt : null,
    finishedAt: typeof final.finishedAt === 'string' ? final.finishedAt : null,
    durationMs: duration(final),
    model: final.publicModel || final.upstreamModel || null,
    provider: final.provider || null,
    connectionId: final.connectionId || null,
    endpoint: final.endpoint || null,
    tokens: tokensOf(final),
    billing,
    attempts: group.attempts.map(safeAttempt),
  };
}

/** Série e agregados por requisição deduplicada; nenhuma moeda é convertida. */
export function buildClientStats({ key, records, entries, now = new Date().toISOString(), period = {} } = {}) {
  if (!key || typeof key !== 'object') return null;
  const parsed = parsePeriod(period);
  if (parsed.error) return { error: parsed.error };
  const range = rangeFor(parsed, now);
  if (range.error) return { error: range.error };

  const days = new Map(datesIn(range).map(date => [date, emptyDay(date)]));
  const relevant = list(records).filter(record => record?.clientKeyId === key.id && inside(record, range));
  const byRequest = new Map(list(entries).filter(entry => entry?.keyId === key.id && entry?.requestId).map(entry => [entry.requestId, entry]));
  const groups = groupRequests(relevant);

  const byModel = new Map(); const byProvider = new Map();
  const totals = { requests: 0, tokens: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, unpriced: 0, spend: new Map() };
  const byStatus = { completed: 0, failed: 0, cancelled: 0, pending: 0 };

  for (const group of groups) {
    const record = group.final; const status = group.status;
    const bucket = days.get(dayOf(record));
    byStatus[status]++; totals[status]++;
    if (bucket) bucket[status]++;
    if (status !== 'completed') continue;

    const tokens = tokensOf(record); const model = record.publicModel || record.upstreamModel || 'modelo';
    const provider = record.provider || 'fornecedor'; const entry = byRequest.get(group.id);
    totals.requests++; totals.tokens += tokens;
    if (bucket) { bucket.requests++; bucket.tokens += tokens; }
    const modelItem = byModel.get(model) || { model, requests: 0, tokens: 0, spend: new Map() };
    modelItem.requests++; modelItem.tokens += tokens; byModel.set(model, modelItem);
    const providerItem = byProvider.get(provider) || { provider, requests: 0, tokens: 0, spend: new Map() };
    providerItem.requests++; providerItem.tokens += tokens; byProvider.set(provider, providerItem);
    if (entry && entry.status === 'settled' && entry.sale !== null && entry.sale !== undefined) {
      addSale(totals.spend, entry); addSale(modelItem.spend, entry); addSale(providerItem.spend, entry);
      if (bucket) addSale(bucket.spend, entry);
    } else totals.unpriced++;
  }

  return {
    account: {
      name: typeof key.name === 'string' ? key.name : 'Chave Anubis',
      label: key.prefix ? `${key.prefix}••••••••` : 'sk-••••••••',
    },
    period: { from: range.start, to: range.end, clamped: range.clamped },
    totals: { ...totals, spend: formatTotals(totals.spend) },
    byStatus,
    series: [...days.values()].map(item => ({ ...item, spend: formatTotals(item.spend) })),
    byModel: finish(byModel), byProvider: finish(byProvider),
    requests: groups.slice(0, DETAIL_LIMIT).map(group => safeRequest(group, safeBilling(byRequest.get(group.id)))),
    detailsTruncated: groups.length > DETAIL_LIMIT,
    scope: 'last_10000_requests', generatedAt: now,
  };
}

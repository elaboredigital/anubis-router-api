// Razão financeira simulada: nenhum valor é debitado, creditado ou liquidado com pagamento real.
import { decimalUnits, formatUnits, recordCost } from './dashboard.js';

const SCALE = 10n ** 12n;

function effectiveVersion(history, scope, provider, model, at, planId) {
  const matches = (Array.isArray(history) ? history : []).filter(version => {
    if (!version || version.scope !== scope) return false;
    if (scope === 'plan' && version.planId !== planId) return false;
    if (scope === 'model' || scope === 'manual') return version.provider === provider && version.model === model;
    return true;
  }).filter(version => !version.effectiveAt || version.effectiveAt <= at);
  matches.sort((a, b) => (a.effectiveAt || '').localeCompare(b.effectiveAt || ''));
  return matches.at(-1) || null;
}

/** Versões vigentes no início da chamada; a versão futura não pode alterar o preço fixado. */
export function resolvePrices(history, at, provider, model, planId = null) {
  const chosen = ['default', 'plan', 'model', 'manual'].map(scope => effectiveVersion(history, scope, provider, model, at, planId)).filter(Boolean);
  const find = scope => chosen.find(version => version.scope === scope);
  return {
    multiplier: find('plan')?.multiplier || find('model')?.multiplier || find('default')?.multiplier || '5',
    manualPrice: find('manual')?.price || null,
    versionIds: chosen.map(version => version.id),
  };
}

function manualSaleUnits(price, record) {
  if (!price || typeof price !== 'object') return null;
  if (price.basis === 'per_request') return decimalUnits(String(price.request));
  if (price.basis !== 'per_1m_tokens') return null;
  const pseudo = {
    status: 'completed', usage: record.usage || {},
    costSnapshot: { billingType: 'token', currency: price.currency, input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite },
  };
  return recordCost(pseudo)?.units ?? null;
}

/** Cotação a partir dos preços fixados: por requisição é exata; por token é estimativa até o uso ser conhecido. */
export function quoteSale(costSnapshot, saleSnapshot = {}, usage = {}) {
  const pseudo = { status: 'completed', usage, costSnapshot };
  const cost = recordCost(pseudo);
  if (!cost) return null;
  const manualPrice = saleSnapshot?.manualPrice || null;
  const manualUnits = manualPrice ? manualSaleUnits(manualPrice, pseudo) : null;
  const multiplier = manualUnits === null ? (saleSnapshot?.multiplier || null) : null;
  const multiplierUnits = multiplier ? decimalUnits(String(multiplier)) : null;
  const units = manualUnits !== null ? manualUnits : (multiplierUnits === null ? null : cost.units * multiplierUnits / SCALE);
  return {
    currency: manualPrice?.currency || cost.currency, costCurrency: cost.currency, costUnits: cost.units,
    units, multiplier, manual: !!manualPrice,
    estimated: !(manualPrice && manualPrice.basis === 'per_request') && costSnapshot?.billingType !== 'request',
  };
}

/** Lançamento por requisição concluída, com custo e venda na mesma moeda ou pendente de conversão. */
export function buildLedgerEntry(record, planId = null) {
  if (!record || record.status !== 'completed' || !record.requestId) return null;
  if (!recordCost(record)) return null;
  // Registros anteriores ao versionamento não têm preço fixado: não se pode inventar valor.
  if (!record.saleSnapshot || typeof record.saleSnapshot !== 'object') return null;
  const snapshot = record.saleSnapshot;
  const quote = quoteSale(record.costSnapshot, snapshot, record.usage);
  if (!quote) return null;
  const pending = quote.units === null || quote.currency !== quote.costCurrency;
  const marginUnits = pending ? null : quote.units - quote.costUnits;
  const marginPercent = !pending && quote.units > 0n ? Math.round(Number(marginUnits * 10000n / quote.units)) / 100 : null;
  return {
    id: `led-${record.requestId}`, requestId: record.requestId, attempt: record.attempt || 1,
    keyId: record.clientKeyId || null, planId, provider: record.provider || null,
    connectionId: record.connectionId || null, model: record.upstreamModel || record.publicModel || null,
    publicModel: record.publicModel || null, startedAt: record.startedAt || null, finishedAt: record.finishedAt || null,
    currency: quote.costCurrency, saleCurrency: quote.currency, cost: formatUnits(quote.costUnits),
    sale: pending ? null : formatUnits(quote.units), margin: pending ? null : formatUnits(marginUnits),
    marginPercent, multiplier: quote.multiplier, manual: quote.manual,
    versionIds: Array.isArray(snapshot.versionIds) ? snapshot.versionIds : [],
    status: pending ? 'pending_conversion' : 'settled',
    reason: pending ? (quote.units === null ? 'preco_indisponivel' : 'moeda_divergente') : null,
  };
}

export function upsertLedgerEntry(entries, entry) {
  if (!entry) return entries;
  const list = Array.isArray(entries) ? entries : [];
  const index = list.findIndex(item => item.id === entry.id);
  if (index < 0) return [...list, entry];
  const next = [...list]; next[index] = entry; return next;
}

function summaryItem(name, currency) {
  return { name, currency, entries: 0, costUnits: 0n, saleUnits: 0n, settled: 0, pending: 0 };
}
function addTo(map, name, currency, entry, cost) {
  const key = `${name}\u0000${currency}`;
  if (!map.has(key)) map.set(key, summaryItem(name, currency));
  const item = map.get(key);
  item.entries++; item.costUnits += cost;
  if (entry.sale === null) { item.pending++; return; }
  const sale = decimalUnits(entry.sale);
  if (sale === null) { item.pending++; return; }
  item.settled++; item.saleUnits += sale;
}
function finish(map) {
  return [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.name.localeCompare(b.name)).map(item => {
    const marginUnits = item.saleUnits - item.costUnits;
    return {
      name: item.name, currency: item.currency, entries: item.entries, settled: item.settled, pending: item.pending,
      cost: formatUnits(item.costUnits), sale: item.settled ? formatUnits(item.saleUnits) : null,
      margin: item.settled ? formatUnits(marginUnits) : null,
      marginPercent: item.settled && item.saleUnits > 0n ? Math.round(Number(marginUnits * 10000n / item.saleUnits)) / 100 : null,
    };
  });
}

/** Resumo por moeda, chave, plano e modelo. Nunca soma valores de moedas diferentes. */
export function summarizeLedger(entries, records = []) {
  const totals = new Map(), byKey = new Map(), byPlan = new Map(), byModel = new Map();
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    const cost = decimalUnits(entry.cost);
    if (cost === null) continue;
    addTo(totals, 'total', entry.currency, entry, cost);
    if (entry.keyId) addTo(byKey, entry.keyId, entry.currency, entry, cost);
    if (entry.planId) addTo(byPlan, entry.planId, entry.currency, entry, cost);
    if (entry.model) addTo(byModel, entry.model, entry.currency, entry, cost);
  }
  const completed = (Array.isArray(records) ? records : []).filter(record => record?.status === 'completed');
  const unpriced = completed.filter(record => !buildLedgerEntry(record, record?.planId)).length;
  return {
    totals: finish(totals), byKey: finish(byKey), byPlan: finish(byPlan), byModel: finish(byModel),
    counts: {
      completed: completed.length, entries: list.length, unpriced,
      pendingConversion: list.filter(entry => entry.status === 'pending_conversion').length,
    },
  };
}

// Visão do cliente final: apenas dados da própria chave, sem promoções, preços de terceiros ou inferência de valores.
import { decimalUnits, formatUnits } from './dashboard.js';
import { monthWindow, dayWindow, usageInWindow, checkPlanQuota, checkDailyQuota } from './plans.js';
import { buildWallets } from './topup.js';

const DAY_MS = 86400000;
const CURRENCY = /^[A-Z]{3}$/;
const list = value => Array.isArray(value) ? value : [];

function windowEndingAt(now, days) {
  const end = new Date(now);
  return { start: new Date(end.getTime() - days * DAY_MS).toISOString(), end: end.toISOString() };
}
function inside(record, window) {
  const at = record?.startedAt || record?.finishedAt;
  return typeof at === 'string' && (!window || (at >= window.start && at < window.end));
}
function tokensOf(record) {
  let tokens = 0;
  for (const field of ['inputTokens', 'outputTokens']) {
    const value = record?.usage?.[field];
    if (Number.isSafeInteger(value) && value >= 0) tokens += value;
  }
  return tokens;
}
function completedRequests(records, keyId, window) {
  const seen = new Set(); const items = [];
  for (const record of records) {
    if (record?.clientKeyId !== keyId || record.status !== 'completed' || !inside(record, window)) continue;
    const id = record.requestId || record.id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    items.push(record);
  }
  return items;
}
function saleUnits(entries, window) {
  const totals = new Map();
  for (const entry of list(entries)) {
    if (entry.status !== 'settled' || entry.sale === null || entry.sale === undefined) continue;
    const currency = CURRENCY.test(entry.saleCurrency || entry.currency || '') ? (entry.saleCurrency || entry.currency) : null;
    if (!currency || !inside(entry, window)) continue;
    const units = decimalUnits(entry.sale);
    if (units === null) continue;
    totals.set(currency, (totals.get(currency) || 0n) + units);
  }
  return totals;
}
function formatTotals(totals) {
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, units]) => ({ currency, amount: formatUnits(units) }));
}
function averageTotals(totals, days) {
  return formatTotals(new Map([...totals.entries()].map(([currency, units]) => [currency, units / BigInt(days)])));
}
function recentRequests(records, entries, keyId, limit = 6) {
  const byRequest = new Map(list(entries).filter(entry => entry?.requestId).map(entry => [entry.requestId, entry]));
  const seen = new Set(); const items = [];
  for (const record of records) {
    if (record?.clientKeyId !== keyId) continue;
    const id = record.requestId || record.id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const entry = byRequest.get(record.requestId);
    const status = entry
      ? (entry.status === 'settled' ? 'settled' : 'pending')
      : record.status === 'completed' ? 'unpriced'
        : record.status === 'cancelled' ? 'cancelled'
          : record.status === 'pending' ? 'pending' : 'failed';
    items.push({
      requestId: id || null, model: record.publicModel || record.upstreamModel || null,
      tokens: tokensOf(record), amount: entry?.sale ?? null,
      currency: entry ? (CURRENCY.test(entry.saleCurrency || entry.currency || '') ? (entry.saleCurrency || entry.currency) : null) : null,
      status, at: record.startedAt || record.finishedAt || null,
    });
    if (items.length >= limit) break;
  }
  return items;
}
function topModels(entries, window, limit = 4) {
  const totals = new Map();
  for (const entry of list(entries)) {
    if (entry.status !== 'settled' || entry.sale === null || entry.sale === undefined || !inside(entry, window)) continue;
    const currency = CURRENCY.test(entry.saleCurrency || entry.currency || '') ? (entry.saleCurrency || entry.currency) : null;
    const units = currency ? decimalUnits(entry.sale) : null;
    if (!currency || units === null) continue;
    const model = entry.publicModel || entry.model || 'modelo';
    const key = `${model}\u0000${currency}`;
    const current = totals.get(key) || { model, currency, units: 0n };
    current.units += units; totals.set(key, current);
  }
  return [...totals.values()]
    .sort((a, b) => (a.units < b.units ? 1 : a.units > b.units ? -1 : a.model.localeCompare(b.model)))
    .slice(0, limit)
    .map(item => ({ model: item.model, currency: item.currency, amount: formatUnits(item.units) }));
}
function percent(used, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) return null;
  return Math.min(100, Math.round(used * 100 / limit));
}

/** Tudo o que a home do cliente pode ver. Nenhum campo bruto de chave, uso ou ledger sai daqui. */
export function buildClientHome({ key, plan, records, entries, topups, plans = [], keys = [], now = new Date().toISOString() } = {}) {
  if (!key || typeof key !== 'object') return null;
  const allRecords = list(records);
  const allEntries = list(entries).filter(entry => entry?.keyId === key.id);
  const last30 = windowEndingAt(now, 30);
  const last7 = windowEndingAt(now, 7);
  const requests30 = completedRequests(allRecords, key.id, last30);
  const requests7 = completedRequests(allRecords, key.id, last7);
  const spend30 = saleUnits(allEntries, last30);
  const spend7 = saleUnits(allEntries, last7);
  const month = monthWindow(now);
  const monthUsage = usageInWindow(allRecords, key.id, month);
  const quota = checkPlanQuota(plan, monthUsage);
  const day = dayWindow(now);
  // A cota diária conta cancelamentos: o fornecedor já descontou a franquia dele.
  const dayUsage = usageInWindow(allRecords, key.id, day, ['completed', 'cancelled']);
  const dailyQuota = checkDailyQuota(plan, dayUsage);
  const hasDailyLimit = plan?.dailyTokens != null || plan?.dailyRequests != null;
  const resetAt = hasDailyLimit ? day.end : (quota.resetAt || month.end);
  // Saldo da conta: soma recargas e gastos de todas as chaves do titular (a principal e as criadas a partir dela).
  const owner = key.parentId || key.id;
  const family = list(keys).filter(item => item && (item.id === owner || item.parentId === owner));
  const wallet = buildWallets(family.length ? family : [key], plans, topups, list(entries)).find(item => item.keyId === owner) || null;
  const firstEntry = allEntries.filter(entry => entry.startedAt).map(entry => entry.startedAt).sort()[0];
  const models = Array.isArray(plan?.models) ? plan.models : [];

  return {
    account: {
      name: typeof key.name === 'string' ? key.name : 'Chave Anubis',
      label: key.prefix ? `${key.prefix}••••••••` : 'sk-••••••••',
      createdAt: key.createdAt || null,
    },
    plan: {
      id: plan?.id || null, name: plan?.name || 'Sem plano', kind: plan?.kind || null,
      active: plan?.active !== false, modelCount: models.length,
      requestsUsed: monthUsage.requests, requestsLimit: plan?.monthlyRequests ?? null,
      tokensUsed: monthUsage.tokens, tokensLimit: plan?.monthlyTokens ?? null,
      dailyRequestsUsed: dayUsage.requests, dailyRequestsLimit: plan?.dailyRequests ?? null,
      dailyTokensUsed: dayUsage.tokens, dailyTokensLimit: plan?.dailyTokens ?? null,
      percentRequests: percent(monthUsage.requests, plan?.monthlyRequests),
      percentTokens: percent(monthUsage.tokens, plan?.monthlyTokens),
      percentDailyRequests: percent(dayUsage.requests, plan?.dailyRequests),
      percentDailyTokens: percent(dayUsage.tokens, plan?.dailyTokens),
      resetAt, daysToReset: Math.max(0, Math.ceil((Date.parse(resetAt) - Date.parse(now)) / DAY_MS)),
      hoursToReset: Math.max(0, Math.ceil((Date.parse(resetAt) - Date.parse(now)) / 3600000)),
      allowed: quota.allowed && dailyQuota.allowed, reason: quota.allowed ? dailyQuota.reason : quota.reason,
    },
    wallet: wallet ? {
      currency: wallet.currency, balance: wallet.balance, credits: wallet.credits,
      consumed: wallet.consumed, pending: wallet.pending, negative: wallet.negative,
    } : null,
    activity: {
      requests30: requests30.length, tokens30: requests30.reduce((total, item) => total + tokensOf(item), 0),
      requests7: requests7.length, tokens7: requests7.reduce((total, item) => total + tokensOf(item), 0),
    },
    spend: {
      last30: formatTotals(spend30), last7: formatTotals(spend7), avgDaily7: averageTotals(spend7, 7),
      paygTotal: formatTotals(saleUnits(allEntries, null)),
      since: firstEntry || key.createdAt || null,
    },
    recent: recentRequests(allRecords, allEntries, key.id),
    topModels: topModels(allEntries, last30),
    scope: 'last_10000_requests', generatedAt: now,
  };
}

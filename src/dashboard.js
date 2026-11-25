// Saldos e custos nesta tela são estimativas administrativas, não lançamentos financeiros.
const SCALE = 12;
export function decimalUnits(value) {
  if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,12})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, '0'));
}
export function formatUnits(value) {
  const negative = value < 0n; let digits = String(negative ? -value : value).padStart(SCALE + 1, '0');
  const whole = digits.slice(0, -SCALE); const fraction = digits.slice(-SCALE).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
const MILLION = 1000000n;

function priceUnits(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return decimalUnits(String(value));
}

function perMillionUnits(units, tokens) {
  if (units === null || !Number.isSafeInteger(tokens) || tokens < 0) return null;
  return units * BigInt(tokens) / MILLION;
}
function perMillion(price, tokens) {
  return perMillionUnits(priceUnits(price), tokens);
}

/** Custo estimado do fornecedor usando o preço capturado no momento da requisição. */
export function recordCost(record) {
  const snapshot = record?.costSnapshot;
  const currency = snapshot?.currency;
  if (record?.status !== 'completed' || !snapshot || snapshot.planOnly || !currency) return null;
  let units;
  if (snapshot.billingType === 'request') {
    units = priceUnits(snapshot.request);
  } else {
    const input = perMillion(snapshot.input, record.usage?.inputTokens || 0);
    const output = perMillion(snapshot.output, record.usage?.outputTokens || 0);
    if (input === null || output === null) return null;
    units = input + output;
    // Tokens em cache já estão incluídos na entrada informada pelo fornecedor: substitui-se a diferença de preço.
    const cached = record.usage?.cachedInputTokens;
    if (Number.isSafeInteger(cached) && cached > 0) {
      const read = priceUnits(snapshot.cacheRead) ?? priceUnits(snapshot.input);
      if (read !== null) units += perMillionUnits(read - priceUnits(snapshot.input), cached);
    }
    const written = record.usage?.cacheWriteTokens;
    if (Number.isSafeInteger(written) && written > 0) {
      const write = priceUnits(snapshot.cacheWrite);
      if (write !== null) units += perMillionUnits(write, written);
    }
  }
  return units === null ? null : { currency, units };
}

function requestCost(record, currency) {
  const cost = recordCost(record);
  return cost && cost.currency === currency ? cost.units : null;
}

/** Uso e gasto por chave Anubis: só requisições concluídas entram no custo. */
export function buildKeyUsage(keys, records) {
  const report = new Map(keys.map(key => [key.id, {
    keyId: key.id, requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
    spendByCurrency: new Map(), unpricedRequests: 0,
  }]));
  for (const record of records) {
    const item = report.get(record.clientKeyId);
    if (!item || record.status !== 'completed') continue;
    item.requests++;
    for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens']) {
      const value = record.usage?.[field];
      if (Number.isSafeInteger(value) && value >= 0) item[field] += value;
    }
    const cost = recordCost(record);
    if (cost) item.spendByCurrency.set(cost.currency, (item.spendByCurrency.get(cost.currency) || 0n) + cost.units);
    else item.unpricedRequests++;
  }
  return [...report.values()].map(item => ({
    keyId: item.keyId, requests: item.requests, inputTokens: item.inputTokens, outputTokens: item.outputTokens, cachedInputTokens: item.cachedInputTokens, cacheWriteTokens: item.cacheWriteTokens,
    spend: [...item.spendByCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, units]) => ({ currency, amount: formatUnits(units) })),
    unpricedRequests: item.unpricedRequests,
  }));
}
export function buildDashboard(connections, accounts, records, day = null) {
  return connections.filter(c => c.active !== false).map(c => {
    const account = accounts.find(a => a.connectionId === c.id) || null;
    const all = records.filter(r => r.connectionId === c.id);
    const dayTokens = day ? all.filter(r => ['completed', 'cancelled'].includes(r.status) && (r.startedAt || r.finishedAt) >= day.start && (r.startedAt || r.finishedAt) < day.end)
      .reduce((total, r) => total + (Number.isSafeInteger(r.usage?.inputTokens) ? r.usage.inputTokens : 0) + (Number.isSafeInteger(r.usage?.outputTokens) ? r.usage.outputTokens : 0), 0) : null;
    const since = account?.balanceAsOf ? all.filter(r => (r.finishedAt || r.startedAt) >= account.balanceAsOf) : [];
    let estimated = 0n, missing = 0;
    if (account?.billingMode === 'payg' && account?.balanceAsOf) for (const r of since) { const cost = requestCost(r, account.currency); if (cost === null) missing++; else estimated += cost; }
    const balance = account?.balance === null || account?.balance === undefined ? null : decimalUnits(account.balance);
    const coverageLimited = !!account?.balanceAsOf && records.length >= 10000 && records.at(-1)?.startedAt > account.balanceAsOf;
    return {
      connectionId: c.id, provider: c.provider, name: c.name, status: c.status, modelCount: c.modelCount,
      account, requestsObserved: all.length, estimatedSpend: account?.billingMode === 'payg' && account?.balanceAsOf ? formatUnits(estimated) : null,
      estimatedBalance: balance !== null && account?.billingMode === 'payg' && account?.balanceAsOf ? formatUnits(balance - estimated) : null,
      unpricedRequests: account?.billingMode === 'payg' && account?.balanceAsOf ? missing : null, coverageLimited,
      dailyUsage: day && account?.dailyTokens ? {
        tokens: dayTokens, limit: account.dailyTokens, remaining: Math.max(0, account.dailyTokens - dayTokens), backup: account.backup === true,
      } : null,
    };
  });
}

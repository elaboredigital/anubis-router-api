// Carteiras e recargas PAYG são simulação administrativa: não há checkout, cobrança ou pagamento real.
import { decimalUnits, formatUnits } from './dashboard.js';

const CURRENCY = /^[A-Z]{3}$/;
const IDEMPOTENCY_KEY = /^[\w-]{1,80}$/;
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function normalizeTopup(data = {}) {
  return {
    keyId: clean(data.keyId, 160),
    amount: clean(data.amount, 32),
    currency: clean(data.currency, 3).toUpperCase(),
    note: clean(data.note, 160),
    idempotencyKey: data.idempotencyKey ? clean(data.idempotencyKey, 80) || null : null,
  };
}

export function validateTopup(topup, key, plan) {
  if (!topup || !key || key.id !== topup.keyId || key.active === false) return 'Chave inválida ou revogada.';
  const payg = plan?.kind === 'payg';
  if (payg && plan.active === false) return 'Plano PAYG inativo.';
  if (!CURRENCY.test(topup.currency || '')) return 'Moeda da recarga inválida: use três letras, como USD.';
  if (payg && topup.currency !== plan.currency) return `Moeda da recarga deve ser ${plan.currency}.`;
  const units = decimalUnits(topup.amount);
  if (units === null || units <= 0n) return 'Informe um valor positivo com até 12 casas decimais.';
  if (typeof topup.note !== 'string' || topup.note.length > 160) return 'Observação muito longa.';
  if (topup.idempotencyKey && !IDEMPOTENCY_KEY.test(topup.idempotencyKey)) return 'Chave de idempotência inválida.';
  return null;
}

/** Saldo simulado: recargas menos vendas liquidadas na razão, sem converter moedas. */
export function buildWallets(keys, plans, topups, entries) {
  const walletList = Array.isArray(keys) ? keys : [];
  const planList = Array.isArray(plans) ? plans : [];
  const wallets = new Map();
  const createWallet = (key, currency, plan) => ({
    keyId: key.id, keyName: typeof key.name === 'string' ? key.name : '', planId: key.planId || null,
    planName: plan ? (typeof plan.name === 'string' ? plan.name : '') : 'Recarga avulsa',
    currency, creditUnits: 0n, debitUnits: 0n, requests: 0, pending: 0,
  });
  for (const key of walletList) {
    if (!key?.id) continue;
    const plan = planList.find(item => item?.id === key.planId);
    if (!plan || plan.kind !== 'payg' || !CURRENCY.test(plan.currency || '')) continue;
    const wallet = createWallet(key, plan.currency, plan);
    wallets.set(`${key.id}\u0000${wallet.currency}`, wallet);
  }

  const seenTopups = new Set();
  for (const item of Array.isArray(topups) ? topups : []) {
    if (!item || !CURRENCY.test(item.currency || '')) continue;
    const marker = item.idempotencyKey ? `idem:${item.idempotencyKey}` : `id:${item.id}`;
    if (seenTopups.has(marker)) continue;
    seenTopups.add(marker);
    const units = decimalUnits(item.amount);
    if (units === null) continue;
    const markerKey = `${item.keyId}\u0000${item.currency}`;
    if (!wallets.has(markerKey)) {
      const key = walletList.find(candidate => candidate?.id === item.keyId);
      if (!key) continue;
      const plan = planList.find(candidate => candidate?.id === key.planId) || null;
      wallets.set(markerKey, createWallet(key, item.currency, plan));
    }
    wallets.get(markerKey).creditUnits += units;
  }

  const seenEntries = new Set();
  for (const item of Array.isArray(entries) ? entries : []) {
    if (!item?.keyId || !['settled', 'pending_conversion'].includes(item.status)) continue;
    const marker = item.id || item.requestId;
    if (marker && seenEntries.has(marker)) continue;
    if (marker) seenEntries.add(marker);
    const owned = [...wallets.values()].filter(wallet => wallet.keyId === item.keyId);
    if (!owned.length) continue;
    const currency = item.saleCurrency || item.currency;
    const wallet = owned.find(candidate => candidate.currency === currency);
    if (!wallet) { owned[0].pending++; continue; }
    const units = item.sale === null || item.sale === undefined ? null : decimalUnits(item.sale);
    if (item.status === 'settled' && units !== null) { wallet.debitUnits += units; wallet.requests++; }
    else wallet.pending++;
  }

  return [...wallets.values()].map(wallet => {
    const balance = wallet.creditUnits - wallet.debitUnits;
    return {
      keyId: wallet.keyId, keyName: wallet.keyName, planId: wallet.planId, planName: wallet.planName,
      currency: wallet.currency, credits: formatUnits(wallet.creditUnits), consumed: formatUnits(wallet.debitUnits),
      balance: formatUnits(balance), requests: wallet.requests, pending: wallet.pending, negative: balance < 0n,
    };
  }).sort((a, b) => a.keyName.localeCompare(b.keyName) || a.keyId.localeCompare(b.keyId));
}

/** Verificação antes da chamada; estimativas por token não podem saber o uso real antecipadamente. */
export function checkWalletBalance(wallet, quote) {
  const result = (allowed, reason, balance = null, required = null) => ({
    allowed, reason, balance, required, currency: wallet?.currency || quote?.currency || null,
  });
  if (!wallet) return result(false, 'no_wallet');
  if (!quote || !CURRENCY.test(quote.currency || '') || quote.currency !== wallet.currency) return result(false, 'currency_pending');
  if (quote.units === null || quote.units === undefined) return result(false, 'unpriced', wallet.balance);
  const balance = decimalUnits(wallet.balance);
  if (balance === null) return result(false, 'unpriced', wallet.balance);
  if (quote.estimated && quote.units === 0n && balance <= 0n) return result(false, 'insufficient_balance', wallet.balance, formatUnits(quote.units));
  if (balance < quote.units) return result(false, 'insufficient_balance', wallet.balance, formatUnits(quote.units));
  return result(true, null, wallet.balance, formatUnits(quote.units));
}

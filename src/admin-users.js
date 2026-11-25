// Administração de usuários sem criar contas: um usuário é a família de chaves com a mesma raiz.
// Nenhuma chave completa, hash, contato em claro, prompt ou resposta sai destes relatórios.
import { decimalUnits, formatUnits } from './dashboard.js';
import { MAX_KEYS_PER_OWNER, rootKeyId, safeKey } from './client-self-service.js';
import { buildWallets } from './topup.js';
import { buildAdminReferralReport } from './referrals.js';

const clean = (value, max = 80) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const CURRENCY = /^[A-Z]{3}$/;

export function findUserFamily(keys = [], rootId = null) {
  if (typeof rootId !== 'string' || !rootId) return null;
  const root = keys.find(key => key && !key.parentId && key.id === rootId);
  if (!root) return null;
  return { root, family: keys.filter(key => key && (key.id === root.id || key.parentId === root.id)) };
}

function sumWallet(wallets, currency) {
  const owned = wallets.filter(item => item?.currency === currency);
  let credits = 0n, consumed = 0n, balance = 0n;
  let requests = 0, pending = 0;
  const keyIds = new Set();
  for (const item of owned) {
    if (item.keyId) keyIds.add(item.keyId);
    for (const [field, add] of [['credits', value => { credits += value; }], ['consumed', value => { consumed += value; }], ['balance', value => { balance += value; }]]) {
      const units = decimalUnits(item[field]);
      if (units !== null) add(units);
    }
    if (Number.isSafeInteger(item.requests) && item.requests > 0) requests += item.requests;
    if (Number.isSafeInteger(item.pending) && item.pending > 0) pending += item.pending;
  }
  return {
    currency, keys: keyIds.size, credits: formatUnits(credits), consumed: formatUnits(consumed),
    balance: formatUnits(balance), requests, pending, negative: balance < 0n,
  };
}

function userActivity(records = [], familyIds = new Set()) {
  const final = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || !familyIds.has(record.clientKeyId)) continue;
    const id = record.requestId || record.id;
    if (!id) continue;
    const at = String(record.finishedAt || record.startedAt || '');
    const previous = final.get(id);
    if (!previous || at >= String(previous.finishedAt || previous.startedAt || '')) final.set(id, record);
  }
  const statuses = [...final.values()];
  return { requests: statuses.filter(item => item.status === 'completed').length, observed: statuses.length };
}

/** Visão agregada por titular. Saldos são somados por moeda; nunca há conversão entre moedas. */
export function buildAdminUsers({ keys = [], plans = [], topups = [], entries = [], records = [], referrals = [], codes = {}, now = new Date().toISOString() } = {}) {
  const roots = keys.filter(key => key && !key.parentId);
  const wallets = buildWallets(keys, plans, topups, entries);
  const referralReport = buildAdminReferralReport({ records: referrals, keys, now, codes });
  const referralOwners = new Map(referralReport.owners.map(owner => [owner.id, owner]));
  const referralsByOwner = new Map();
  for (const item of referralReport.records) {
    if (!referralsByOwner.has(item.ownerKeyId)) referralsByOwner.set(item.ownerKeyId, []);
    referralsByOwner.get(item.ownerKeyId).push(item);
  }

  const users = roots.map(root => {
    const family = keys.filter(key => key && (key.id === root.id || key.parentId === root.id));
    const familyIds = new Set(family.map(key => key.id));
    const ownedCurrencies = [...new Set(wallets.filter(item => familyIds.has(item.keyId)).map(item => item.currency))].filter(currency => CURRENCY.test(currency)).sort();
    const ownerReferrals = referralOwners.get(root.id);
    const plan = plans.find(item => item?.id === root.planId);
    return {
      id: root.id,
      name: clean(root.name, 80) || 'Titular sem nome',
      label: root.prefix ? `${root.prefix}••••••••` : '—',
      createdAt: root.createdAt || null,
      active: root.active !== false,
      blocked: root.active === false,
      planId: root.planId || null,
      planName: plan?.name || 'Sem plano',
      keys: family.map(key => safeKey(key, plans, root.id)),
      keyCount: family.length,
      activeKeys: family.filter(key => key.active !== false).length,
      maxKeys: MAX_KEYS_PER_OWNER,
      activity: userActivity(records, familyIds),
      wallets: ownedCurrencies.map(currency => sumWallet(wallets, currency)),
      referrals: {
        code: ownerReferrals?.code || '',
        stats: ownerReferrals?.stats || referralReport.totals,
        records: referralsByOwner.get(root.id) || [],
      },
    };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));

  const allCurrencies = [...new Set(wallets.map(item => item.currency))].filter(currency => CURRENCY.test(currency)).sort();
  return {
    users,
    totals: {
      users: users.length,
      activeUsers: users.filter(user => !user.blocked).length,
      blockedUsers: users.filter(user => user.blocked).length,
      keys: users.reduce((total, user) => total + user.keyCount, 0),
      activeKeys: users.reduce((total, user) => total + user.activeKeys, 0),
      wallets: allCurrencies.map(currency => sumWallet(wallets, currency)),
      referrals: referralReport.totals,
    },
    program: referralReport.program,
    limits: { maxKeys: MAX_KEYS_PER_OWNER },
    generatedAt: now,
  };
}

export function validateUserPlan(data, plans = [], family = []) {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'planId')) return 'Informe um plano.';
  const planId = data.planId || null;
  if (planId && !plans.some(plan => plan?.id === planId)) return 'Plano não encontrado.';
  if (!family.length) return 'Usuário não encontrado.';
  return null;
}

export function validateUserActive(data) {
  if (!data || typeof data.active !== 'boolean') return 'Informe se o usuário deve ficar bloqueado ou desbloqueado.';
  return null;
}

export function validateUserKeyCreate(data, family = [], plans = []) {
  const name = clean(data?.name);
  if (!name || name.length > 80) return 'Informe um nome com até 80 caracteres.';
  if (family.length >= MAX_KEYS_PER_OWNER) return `Limite local de ${MAX_KEYS_PER_OWNER} chaves por titular atingido.`;
  const root = family.find(key => !key.parentId);
  if (!root) return 'Usuário não encontrado.';
  if (root.active === false) return 'Usuário bloqueado; desbloqueie antes de criar chaves.';
  const planId = data.planId || null;
  if (planId && !plans.some(plan => plan?.id === planId)) return 'Plano não encontrado.';
  return null;
}

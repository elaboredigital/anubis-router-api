// Área do cliente sem contas: a posse de uma chave ativa define o grupo dessa chave.
// A chave raiz é a chave criada pelo admin; filhas são criadas pela própria chave e nunca contêm segredos extras.
import { buildClientHome } from './client-home.js';
import { buildClientStats } from './client-stats.js';
import { buildWallets } from './topup.js';

export const MAX_KEYS_PER_OWNER = 10;
const clean = (value, max = 80) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function isSelfServicePlan(plan) {
  return !!plan && plan.active !== false && (plan.selfService === true || (plan.id === 'free' && plan.selfService === undefined));
}

export function rootKeyId(key) {
  return key?.parentId || key?.id || null;
}

export function ownerKeys(keys, key) {
  const root = rootKeyId(key);
  return keys.filter(item => item && (item.id === root || item.parentId === root));
}

export function safePlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id, name: plan.name, kind: plan.kind, active: plan.active !== false,
    selfService: isSelfServicePlan(plan),
    monthlyRequests: plan.monthlyRequests ?? null,
    monthlyTokens: plan.monthlyTokens ?? null,
    dailyRequests: plan.dailyRequests ?? null,
    dailyTokens: plan.dailyTokens ?? null,
    models: Array.isArray(plan.models) ? plan.models.slice(0, 500) : [],
    currency: plan.kind === 'payg' ? (plan.currency || null) : null,
  };
}

export function safeKey(key, plans = [], root = rootKeyId(key)) {
  if (!key) return null;
  const plan = plans.find(item => item.id === key.planId) || null;
  return {
    id: key.id,
    name: clean(key.name),
    label: key.prefix ? `${key.prefix}••••••••` : 'sk-••••••••',
    createdAt: key.createdAt || null,
    active: key.active !== false,
    planId: key.planId || null,
    planName: plan?.name || 'Sem plano',
    role: key.id === root ? 'principal' : 'derivada',
  };
}

export function buildSelfServiceSummary({ key, keys = [], plans = [], records = [], entries = [], topups = [], now = new Date().toISOString() } = {}) {
  if (!key) return null;
  const root = rootKeyId(key);
  const home = buildClientHome({ key, plan: plans.find(item => item.id === key.planId) || null, records, entries, topups, plans, now });
  return {
    ...home,
    account: { ...home.account, id: key.id, isRoot: key.id === root },
    selfService: true,
    availablePlans: plans.filter(isSelfServicePlan).map(safePlan),
    keys: ownerKeys(keys, key).map(item => safeKey(item, plans, root)),
    limits: { maxKeys: MAX_KEYS_PER_OWNER },
  };
}

export function buildSelfServiceStats(args) {
  return buildClientStats(args);
}

export function validateCreateKey(data, family, plans, key) {
  const name = clean(data?.name);
  if (!name || name.length > 80) return 'Informe um nome com até 80 caracteres.';
  if (family.length >= MAX_KEYS_PER_OWNER) return `Limite local de ${MAX_KEYS_PER_OWNER} chaves por titular atingido.`;
  const planId = data.planId || null;
  if (planId) {
    const plan = plans.find(item => item.id === planId);
    if (!isSelfServicePlan(plan)) return 'Plano indisponível para criação pelo cliente.';
  }
  if (!planId && !isSelfServicePlan(plans.find(item => item.id === key.planId))) return 'A chave principal precisa de um plano de cliente antes de criar outras chaves.';
  return null;
}

export function validatePlanChange(data, family, plans) {
  if (typeof data?.id !== 'string' || !data.id) return 'ID inválido.';
  const target = family.find(item => item.id === data.id);
  if (!target) return 'Chave não encontrada no seu grupo.';
  const planId = data.planId || null;
  if (!planId) return 'Escolha um plano; chaves sem plano não têm limite local.';
  const plan = plans.find(item => item.id === planId);
  if (!isSelfServicePlan(plan)) return 'Plano indisponível para troca pelo cliente.';
  return null;
}

export function validateRevoke(data, family) {
  if (typeof data?.id !== 'string' || !data.id) return 'ID inválido.';
  const target = family.find(item => item.id === data.id);
  if (!target) return 'Chave não encontrada no seu grupo.';
  if (!target.parentId) return 'A chave principal só pode ser revogada no painel administrativo.';
  return null;
}

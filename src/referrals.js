// Programa de indicações (28/11/2026): quem se cadastra pelo link e faz o primeiro depósito de US$ 20 ou mais
// rende US$ 5 de crédito real no saldo de quem indicou, lançado na hora como recarga ("Bônus de indicação").
// Sem saque nem conversão de moeda: o bônus só vale como crédito de uso.
import { randomBytes } from 'node:crypto';
import { decimalUnits, formatUnits } from './dashboard.js';

export const REFERRAL_PROGRAM = Object.freeze({
  currency: 'USD',
  qualifyAmount: '20.00',
  holdDays: 0,
  minCredit: '5.00',
  ladder: Object.freeze([
    Object.freeze({ from: 1, to: null, amount: '5.00' }),
  ]),
  note: 'Quando alguém se cadastra pelo seu link e faz o primeiro depósito de US$ 20 ou mais, você ganha US$ 5 de crédito no saldo.',
});

const clean = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
// Texto livre do administrador também pode conter contato ou chave: mascara antes de persistir.
export function safeText(value, max = 160) {
  return clean(value, max)
    .replace(/\banubis_[A-Za-z0-9_-]{6,}\b/g, 'anubis_***')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, match => maskContact(match));
}
const units = value => decimalUnits(typeof value === 'string' ? value : String(value ?? ''));
const money = value => {
  const [whole, fraction = ''] = formatUnits(value).split('.');
  return { amount: `${whole}.${fraction.padEnd(2, '0')}`, currency: REFERRAL_PROGRAM.currency };
};
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;

/** Código público aleatório. Não deriva da chave, não é credencial e não é um hash da chave. */
export function makeReferralCode() {
  return randomBytes(5).toString('hex').toUpperCase();
}
const codeFor = (ownerKeyId, codes) => (codes && typeof codes[ownerKeyId] === 'string' ? codes[ownerKeyId] : '');

export function publicProgram() {
  return {
    currency: REFERRAL_PROGRAM.currency,
    qualifyAmount: REFERRAL_PROGRAM.qualifyAmount,
    holdDays: REFERRAL_PROGRAM.holdDays,
    minCredit: REFERRAL_PROGRAM.minCredit,
    ladder: REFERRAL_PROGRAM.ladder.map(item => ({ ...item })),
    note: REFERRAL_PROGRAM.note,
  };
}

/** Nunca persiste ou devolve o contato completo: apenas uma forma mascarada. */
export function maskContact(value) {
  const text = clean(value);
  if (!text) return '';
  const at = text.lastIndexOf('@');
  if (at > 0 && at < text.length - 1) {
    const domain = text.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    return `${text[0]}***@***${dot > 0 ? domain.slice(dot) : ''}`.slice(0, 40);
  }
  return `${text.slice(0, 2)}***`.slice(0, 40);
}

export function rewardForPosition(position) {
  if (!Number.isSafeInteger(position) || position < 1) return null;
  return REFERRAL_PROGRAM.ladder.find(item => position >= item.from && (item.to === null || position <= item.to))?.amount || null;
}

function plusDays(timestamp, days) {
  return new Date(Date.parse(timestamp) + days * 86400000).toISOString();
}

export function normalizeReferral(data = {}) {
  return {
    id: clean(data.id, 80) || null,
    ownerKeyId: clean(data.ownerKeyId, 160),
    contact: maskContact(data.contact),
    status: 'cadastro',
    createdAt: iso(data.createdAt),
    depositAmount: null,
    depositCurrency: null,
    reference: safeText(data.reference, 80),
    qualifiedAt: null,
    rewardAmount: null,
    rewardCurrency: null,
    holdUntil: null,
    reviewedAt: null,
    movedAt: null,
    note: safeText(data.note),
  };
}

export function validateRegister(data, rootIds = []) {
  if (!rootIds.includes(clean(data?.ownerKeyId, 160))) return 'Titular inválido: use uma chave principal do painel.';
  if (!clean(data?.contact)) return 'Informe o contato ou identificador da indicação.';
  return null;
}

export function validateQualify(data, referral, now = new Date().toISOString()) {
  if (!referral || !['cadastro', 'em_analise'].includes(referral.status)) return 'Indicação não está disponível para qualificação.';
  const amount = units(data?.depositAmount);
  if (amount === null || amount <= 0n) return 'Informe o depósito com valor numérico válido.';
  if (amount < units(REFERRAL_PROGRAM.qualifyAmount)) return `O depósito informado precisa ser de pelo menos ${REFERRAL_PROGRAM.qualifyAmount} ${REFERRAL_PROGRAM.currency}.`;
  const currency = clean(data?.currency, 3).toUpperCase() || REFERRAL_PROGRAM.currency;
  if (currency !== REFERRAL_PROGRAM.currency) return `A moeda informada deve ser ${REFERRAL_PROGRAM.currency}; não há conversão.`;
  const when = data?.qualifiedAt ? iso(data.qualifiedAt) : iso(now);
  if (!when) return 'Data de qualificação inválida: use ISO UTC.';
  return null;
}

export function applyQualify(referral, data, records = [], now = new Date().toISOString()) {
  const qualifiedAt = iso(data?.qualifiedAt) || now;
  const amount = units(data.depositAmount);
  const previous = records.filter(item => item.ownerKeyId === referral.ownerKeyId && ['qualificada', 'creditado'].includes(item.status) && item.rewardAmount)
    .sort((a, b) => String(a.qualifiedAt || '').localeCompare(String(b.qualifiedAt || '')) || String(a.id || '').localeCompare(String(b.id || '')));
  const position = previous.some(item => item.id === referral.id) ? previous.findIndex(item => item.id === referral.id) + 1 : previous.length + 1;
  return {
    ...referral,
    status: 'qualificada',
    depositAmount: formatUnits(amount),
    depositCurrency: REFERRAL_PROGRAM.currency,
    reference: safeText(data?.reference, 80),
    qualifiedAt,
    rewardAmount: rewardForPosition(position),
    rewardCurrency: REFERRAL_PROGRAM.currency,
    holdUntil: plusDays(qualifiedAt, REFERRAL_PROGRAM.holdDays),
    reviewedAt: now,
  };
}

export function validateStatus(data, referral) {
  if (!['em_analise', 'rejeitada'].includes(data?.status)) return 'Status inválido.';
  if (!referral) return 'Indicação não encontrada.';
  if (referral.status === 'creditado') return 'Crédito já movido não pode ser alterado.';
  if (data.status === 'rejeitada' && !clean(data?.reason)) return 'Informe o motivo da rejeição.';
  return null;
}

export function applyStatus(referral, status, now = new Date().toISOString(), reason = '') {
  return {
    ...referral,
    status,
    rewardAmount: null,
    rewardCurrency: null,
    qualifiedAt: null,
    holdUntil: null,
    reviewedAt: now,
    note: reason ? `${referral.note || ''} ${safeText(reason)}`.trim().slice(0, 160) : referral.note,
  };
}

export function buildReferralStats(records = [], ownerKeyId = null, now = new Date().toISOString()) {
  const scoped = ownerKeyId ? records.filter(item => item.ownerKeyId === ownerKeyId) : records;
  const counted = scoped.filter(item => ['qualificada', 'creditado'].includes(item.status));
  let pending = 0n, blocked = 0n, available = 0n, earned = 0n, eligible = 0n;
  const eligibleIds = [];
  for (const item of counted) {
    const amount = units(item.rewardAmount) ?? 0n;
    if (item.status === 'creditado') { earned += amount; continue; }
    if (!item.holdUntil || Date.parse(item.holdUntil) > Date.parse(now)) { pending += amount; continue; }
    eligibleIds.push(item.id);
    eligible += amount;
  }
  const canMove = eligible >= units(REFERRAL_PROGRAM.minCredit);
  if (canMove) available = eligible; else blocked = eligible;
  const qualified = counted.length;
  const nextPosition = qualified + 1;
  const nextTier = REFERRAL_PROGRAM.ladder.find(item => item.from > nextPosition);
  return {
    signups: scoped.length,
    qualified,
    inAnalysis: scoped.filter(item => item.status === 'em_analise').length,
    rejected: scoped.filter(item => item.status === 'rejeitada').length,
    pending: money(pending),
    blocked: money(blocked),
    available: money(available),
    earned: money(earned),
    eligible: money(eligible),
    canMove,
    eligibleIds,
    movableIds: canMove ? eligibleIds : [],
    nextPosition,
    nextReward: rewardForPosition(nextPosition),
    remainingForTier: nextTier ? nextTier.from - qualified : 0,
    tierFrom: nextTier?.from ?? null,
  };
}

export function safeReferral(item, keys = [], forAdmin = false, codes = {}) {
  if (!item) return null;
  const owner = keys.find(key => (key.parentId || key.id) === item.ownerKeyId);
  const result = {
    id: item.id,
    ownerKeyId: item.ownerKeyId,
    ownerName: owner?.name || null,
    code: codeFor(item.ownerKeyId, codes),
    contact: item.contact || '',
    status: item.status,
    createdAt: item.createdAt || null,
    qualifiedAt: item.qualifiedAt || null,
    holdUntil: item.holdUntil || null,
    movedAt: item.movedAt || null,
    rewardAmount: item.rewardAmount || null,
    rewardCurrency: item.rewardCurrency || null,
    depositCurrency: item.depositCurrency || null,
    note: item.note || '',
  };
  if (forAdmin) result.reference = item.reference || '';
  return result;
}

export function buildClientReferralReport({ key, records = [], now = new Date().toISOString(), baseUrl = '', codes = {}, activity = {} } = {}) {
  if (!key) return null;
  const root = key.parentId || key.id;
  const code = codeFor(root, codes);
  return {
    program: publicProgram(),
    account: { id: key.id, label: key.prefix ? `${key.prefix}••••••••` : '—' },
    code,
    link: `${String(baseUrl).replace(/\/+$/, '')}/signup${code ? `?ref=${code}` : ''}`,
    stats: buildReferralStats(records, root, now),
    referrals: records.filter(item => item.ownerKeyId === root)
      .map(item => ({ ...safeReferral(item, [], false, codes), ...(activity[item.id] || {}) }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  };
}

export function buildAdminReferralReport({ records = [], keys = [], now = new Date().toISOString(), codes = {} } = {}) {
  const roots = keys.filter(key => !key.parentId);
  const owners = roots.map(key => {
    const root = key.id;
    return {
      id: root,
      name: key.name || 'Chave principal',
      label: key.prefix ? `${key.prefix}••••••••` : '—',
      code: codeFor(root, codes),
      stats: buildReferralStats(records, root, now),
    };
  });
  const totals = buildReferralStats(records, null, now);
  return {
    program: publicProgram(),
    totals,
    owners,
    records: records.map(item => safeReferral(item, keys, true, codes)).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  };
}

export function validateMoveCredit(records = [], ids = [], ownerKeyId = null, now = new Date().toISOString()) {
  if (!Array.isArray(ids) || !ids.length) return 'Selecione pelo menos uma indicação elegível.';
  const unique = [...new Set(ids)];
  const selected = records.filter(item => unique.includes(item.id));
  if (selected.length !== unique.length) return 'Uma ou mais indicações não foram encontradas.';
  if (ownerKeyId && selected.some(item => item.ownerKeyId !== ownerKeyId)) return 'Indicação fora do titular informado.';
  if (selected.some(item => item.status !== 'qualificada' || !item.holdUntil || Date.parse(item.holdUntil) > Date.parse(now))) return 'Só é possível mover indicações qualificadas após o período de espera.';
  const total = selected.reduce((sum, item) => sum + (units(item.rewardAmount) ?? 0n), 0n);
  if (total < units(REFERRAL_PROGRAM.minCredit)) return `O crédito movido precisa somar pelo menos ${REFERRAL_PROGRAM.minCredit} ${REFERRAL_PROGRAM.currency}.`;
  return null;
}

// Contas de cliente: o e-mail é o identificador. Cadastro com e-mail e senha, confirmação por e-mail,
// login por e-mail e senha ou por link mágico enviado ao e-mail.
// A conta é dona de uma chave raiz (a família de chaves continua sendo o "usuário" de saldo, plano e indicações).
// Senhas usam scrypt; tokens de e-mail e de sessão são guardados apenas como hash SHA-256.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const VERIFY_TTL_MS = 48 * 3600_000;
export const MAGIC_TTL_MS = 15 * 60_000;
const EMAIL = /^[^\s@<>()"',;]{1,64}@[^\s@<>()"',;]+\.[a-z]{2,24}$/i;

export const tokenHash = value => createHash('sha256').update(String(value)).digest('hex');
export const newToken = (prefix = '') => `${prefix}${randomBytes(32).toString('base64url')}`;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [kind, n, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const normalizeLogin = value => typeof value === 'string' ? value.trim().toLowerCase().slice(0, 254) : '';

/** Valida o cadastro (e-mail e senha) e devolve os campos normalizados, ou { error }. */
export function validateSignup(accounts, data) {
  const email = normalizeLogin(data?.email);
  const password = typeof data?.password === 'string' ? data.password : '';
  if (!EMAIL.test(email)) return { error: 'Informe um e-mail válido.' };
  if (password.length < 8 || password.length > 200) return { error: 'A senha deve ter de 8 a 200 caracteres.' };
  const lower = password.toLowerCase();
  if (lower === email || lower === email.split('@')[0]) return { error: 'A senha não pode ser igual ao e-mail.' };
  if (accounts.some(a => a.email === email)) return { error: 'Já existe uma conta com este e-mail. Entre ou peça um link de acesso.', field: 'email' };
  return { email, password };
}

/** Acha a conta pelo e-mail. Contas antigas ainda têm "username" salvo, mas ele não serve mais para entrar. */
export function findAccountByLogin(accounts, login) {
  const value = normalizeLogin(login);
  if (!value || !value.includes('@')) return null;
  return accounts.find(a => a.email === value) || null;
}

/** Cria um token de uso único (confirmação ou link mágico). Remove tokens vencidos e os anteriores do mesmo tipo. */
export function issueEmailToken(tokens, { accountId, type, now = Date.now() }) {
  const value = newToken();
  const ttl = type === 'verify' ? VERIFY_TTL_MS : MAGIC_TTL_MS;
  const kept = tokens.filter(t => Date.parse(t.expiresAt) > now && !(t.accountId === accountId && t.type === type));
  kept.push({ hash: tokenHash(value), accountId, type, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString() });
  return { value, tokens: kept };
}
/** Consome o token: devolve a conta e a lista sem ele, ou { error }. */
export function consumeEmailToken(tokens, value, type, now = Date.now()) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 200) return { error: 'Link inválido.' };
  const hash = tokenHash(value);
  const found = tokens.find(t => t.hash === hash && t.type === type);
  if (!found) return { error: 'Link inválido ou já usado.' };
  if (Date.parse(found.expiresAt) <= now) return { error: 'Link vencido. Peça um novo.', tokens: tokens.filter(t => t !== found) };
  return { accountId: found.accountId, tokens: tokens.filter(t => t !== found) };
}

export function publicAccount(account, key = null) {
  return {
    id: account.id, email: account.email, emailVerified: !!account.emailVerifiedAt,
    createdAt: account.createdAt, keyId: account.keyId || null, keyPrefix: key?.prefix || null,
  };
}

/** Limite simples em memória por chave (IP, e-mail): até `max` eventos na janela. */
export function createLimiter(max, windowMs) {
  const hits = new Map();
  return {
    take(key, now = Date.now()) {
      const list = (hits.get(key) || []).filter(at => now - at < windowMs);
      if (list.length >= max) { hits.set(key, list); return false; }
      list.push(now); hits.set(key, list);
      if (hits.size > 50_000) for (const [k, v] of hits) if (!v.some(at => now - at < windowMs)) hits.delete(k);
      return true;
    },
    count(key, now = Date.now()) { return (hits.get(key) || []).filter(at => now - at < windowMs).length; },
    /** Devolve o último evento (ex.: chamada que falhou do nosso lado não gasta a cota). */
    refund(key) { const list = hits.get(key); if (list?.length) list.pop(); },
  };
}

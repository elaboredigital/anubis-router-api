import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { timingSafeEqual, randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openStore, openEntries } from './store.js';
import { connectors, connector } from './connectors.js';
import { providerFetch, validBase } from './provider-http.js';
import { openUsageStore, usageObserver, summarizeUsage, estimateInputTokens, finalizeUsage, DEFAULT_USAGE_RETENTION, normalizeUsageRetention, validateUsageRetention } from './usage.js';
import { collectSystemReport, createTrafficCounters } from './system-metrics.js';
import { buildDashboard, buildKeyUsage, decimalUnits } from './dashboard.js';
import { buildConnectDiagnostic } from './diagnostics.js';
import { priceSnapshot } from './pricing.js';
import { DEFAULT_FREE_PLAN, validatePlan, monthWindow, dayWindow, usageInWindow, checkPlanQuota, checkDailyQuota, planAllowsModel, buildKeyBilling } from './plans.js';
import { resolvePrices, quoteSale, buildLedgerEntry, upsertLedgerEntry, summarizeLedger } from './ledger.js';
import { normalizeTopup, validateTopup, buildWallets, checkWalletBalance } from './topup.js';
import { DEFAULT_ROUTING_POLICY, normalizeRoutingPolicy, validateRoutingPolicy, normalizeRoutingFields, validateRoutingFields, orderedCandidates, nextCursor, shouldRetry, resolveTimeout, isCoolingDown, buildRouteAudit } from './routing-policy.js';
import { parsePeriod, filterByPeriod, listPending, normalizeReconciliation, validateReconciliation, applyReconciliation } from './reconciliation.js';
import { buildClientHome } from './client-home.js';
import { buildClientStats } from './client-stats.js';
import { MAX_KEYS_PER_OWNER, rootKeyId, ownerKeys, buildSelfServiceSummary, validateCreateKey, validatePlanChange, validateRevoke } from './client-self-service.js';
import { buildAdminUsers, findUserFamily, validateUserActive, validateUserKeyCreate, validateUserPlan } from './admin-users.js';
import { buildGlobalStats } from './global-stats.js';
import { buildModelAnalytics } from './model-analytics.js';
import { buildReadiness, normalizeReadinessUpdate, validateReadinessUpdate, commercialBlock, CONNECTION_BLOCKED, DEFAULT_READINESS_POLICY } from './provider-readiness.js';
import { MAXROUTER_PRICING_PAGE, MAXROUTER_PRICING_URL, parseMaxRouterPrices } from './maxrouter-pricing.js';
import { buildAdminAvailability, buildPublicCatalog, modelPricing } from './public-catalog.js';
import { SESSION_TTL_MS, tokenHash, newToken, hashPassword, verifyPassword, validateSignup, findAccountByLogin, issueEmailToken, consumeEmailToken, publicAccount, createLimiter } from './accounts.js';
import { createMailer } from './mailer.js';
import { findGateway, publicGateways, parseNotification } from './payments.js';
import { createFx, normalizeFxConfig, validateFxConfig, DEFAULT_FX_CONFIG } from './fx.js';
import { CREDIT_PLAN, TOPUP_PRESETS, MIN_TOPUP, MAX_TOPUP, ensureCreditPlan, validateTopupRequest, clientTopupRequest, clientStatement, spendByModel, verifyPaymentSignature, validatePaymentConfirmation } from './credits.js';
import { makeReferralCode, safeText, normalizeReferral, validateRegister, validateQualify, applyQualify, validateStatus, applyStatus, buildClientReferralReport, buildAdminReferralReport, validateMoveCredit } from './referrals.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A API não publica interface própria. ANUBIS_WEB_ROOT só é usado no monorepo de transição,
// enquanto site público e painel ainda são servidos por este processo durante a separação.
const webRoot = path.resolve(root, process.env.ANUBIS_WEB_ROOT || '.');
const webFile = file => path.join(webRoot, file);
const extensionDir = path.join(root, 'extension');
// A versão exibida no painel vem do manifesto da extensão; o nome do VSIX acompanha essa versão.
let extensionVersion = '0.1.0';
try {
  const manifest = JSON.parse(await readFile(path.join(extensionDir, 'package.json'), 'utf8'));
  if (typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) extensionVersion = manifest.version;
} catch { /* instalações sem o pacote da extensão caem na versão do nome do arquivo */ }
const extensionFile = `anubis-router-vscode-${extensionVersion}.vsix`;
const extensionPath = path.join(extensionDir, extensionFile);
async function extensionAvailable() {
  try { return (await stat(extensionPath)).isFile(); } catch { return false; }
}
// Editores que instalam extensões no formato VS Code: todos usam o mesmo pacote.
const extensionTargets = [
  { id: 'vscode', label: 'VS Code', cli: 'code', note: 'VS Code 1.85 ou superior.' },
  { id: 'cursor', label: 'Cursor', cli: 'cursor', note: 'Fork do VS Code; instala o mesmo pacote.' },
  { id: 'windsurf', label: 'Windsurf', cli: 'windsurf', note: 'Fork do VS Code; sem o comando no PATH, use Install from VSIX.' },
  { id: 'vscodium', label: 'VSCodium', cli: 'codium', note: 'Build livre do VS Code; instala o mesmo pacote.' },
];
const defaultRoutes = [{ id: 'anubis/devstral', provider: 'xkiro', upstreamModel: 'mistralai/devstral-medium', enabled: true }];
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || '127.0.0.1';
// Origens aceitas pelo painel e pelo site: dev local e endereços públicos (ANUBIS_PUBLIC_URL, separado por vírgula).
const allowedOrigins = new Set([
  `http://localhost:${port}`, `http://127.0.0.1:${port}`,
  'http://localhost:3000', 'http://127.0.0.1:3000',
  'http://localhost:3001', 'http://127.0.0.1:3001',
  ...(process.env.ANUBIS_PUBLIC_URL || '').split(',').map(u => u.trim().replace(/\/+$/, '')).filter(Boolean),
]);
const adminKey = process.env.ANUBIS_ADMIN_KEY;
const encryptionKey = process.env.ANUBIS_ENCRYPTION_KEY;
if (!adminKey || adminKey.length < 16 || adminKey.includes('crie_') || !/^[a-f0-9]{64}$/i.test(encryptionKey || '')) {
  console.error('Configure ANUBIS_ADMIN_KEY e ANUBIS_ENCRYPTION_KEY (64 caracteres hexadecimais) no .env.'); process.exit(1);
}
const masterKey = Buffer.from(encryptionKey, 'hex');
const upstream = process.env.NODE_ENV === 'test' && process.env.TEST_UPSTREAM_URL ? process.env.TEST_UPSTREAM_URL : 'https://api.xkiro.com';
const store = await openStore(root);
// Razão, recargas e pedidos de recarga: uma linha por item (ver openEntries), sem regravar a lista inteira.
const entries = await openEntries(root);
/** Lê os itens de um tipo; na primeira vez, copia a lista antiga do store (que fica intacta como cópia). */
async function loadEntries(kind) {
  const current = await entries.list(kind);
  if (current.length) return current;
  const legacy = await store.load(kind, []);
  if (!Array.isArray(legacy)) throw new Error(`Dados de ${kind} inválidos`);
  if (legacy.length) { await entries.upsertMany(kind, legacy); console.warn(`${kind}: ${legacy.length} itens migrados para uma linha por item.`); }
  return legacy;
}
const usageStore = await openUsageStore(root);
const traffic = createTrafficCounters();
let routes = await store.load('routes', defaultRoutes);
if (!Array.isArray(routes)) throw new Error('Formato inválido das rotas');
routes = routes.map((r, i) => ({
  ...r,
  destinationId: r.destinationId || createHash('sha256').update(JSON.stringify([r.id, r.provider, r.connectionId || '', r.upstreamModel, i])).digest('hex').slice(0, 24),
  priority: r.priority ?? 100,
  ...normalizeRoutingFields(r),
}));
let credentials = await store.load('credentials', {});
let clientKeys = await store.load('api-keys', []);
let providerAccounts = await store.load('provider-accounts', []);
if (!Array.isArray(providerAccounts)) throw new Error('Dados de saldo inválidos');
let pricingConfig = await store.load('pricing-config', { defaultMultiplier: '5', rules: [] });
if (!pricingConfig || !Array.isArray(pricingConfig.rules)) throw new Error('Configuração de preços inválida');
if (pricingConfig.manualPrices === undefined) pricingConfig.manualPrices = [];
if (!Array.isArray(pricingConfig.manualPrices)) throw new Error('Preços manuais inválidos');
let plans = await store.load('plans', [DEFAULT_FREE_PLAN]);
if (!Array.isArray(plans)) throw new Error('Planos inválidos');
plans = plans.map(plan => {
  const migrated = { ...plan, dailyRequests: plan?.dailyRequests ?? null, dailyTokens: plan?.dailyTokens ?? null, selfService: plan?.selfService === true || (plan?.id === 'free' && plan?.selfService === undefined) };
  // Plano gratuito da instalação anterior (100 req e 1M tokens/mês) passa para a franquia diária de 500 mil tokens.
  if (plan?.id === 'free' && plan.dailyTokens === undefined && plan.monthlyRequests === 100 && plan.monthlyTokens === 1000000) { migrated.monthlyRequests = null; migrated.monthlyTokens = null; migrated.dailyTokens = DEFAULT_FREE_PLAN.dailyTokens; }
  return migrated;
});
if (!Array.isArray(clientKeys) || !credentials || Array.isArray(credentials) || typeof credentials !== 'object') throw new Error('Dados persistidos inválidos');
let ledger = await loadEntries('ledger');
// Plano padrão de créditos pré-pagos em USD: criado uma vez, depois editável pelo admin como qualquer plano.
if (!plans.some(plan => plan?.id === CREDIT_PLAN.id)) { plans = ensureCreditPlan(plans); await store.save('plans', plans); }
let topupRequests = await loadEntries('topup-requests');
let topups = await loadEntries('topups');
// Outro processo (ex.: o container antigo durante um redeploy) pode gravar itens novos: relê a cada 15 s.
const replaceById = (list, item) => { const index = list.findIndex(x => x?.id === item.id); if (index < 0) return [...list, item]; const next = [...list]; next[index] = item; return next; };
let entriesCursor = await entries.now();
async function syncEntries() {
  try {
    const since = new Date(Date.parse(entriesCursor) - 5000).toISOString();
    let cursor = entriesCursor;
    for (const kind of ['ledger', 'topups', 'topup-requests']) {
      const changed = await entries.changedSince(kind, since);
      if (changed.cursor > cursor) cursor = changed.cursor;
      for (const item of changed.items) {
        if (kind === 'ledger') ledger = upsertLedgerEntry(ledger, item);
        else if (kind === 'topups') topups = replaceById(topups, item);
        else topupRequests = replaceById(topupRequests, item);
      }
    }
    entriesCursor = cursor;
  } catch (error) { console.error('Releitura da razão falhou:', error.code || error.message); }
}
setInterval(() => { void syncEntries(); }, 15_000).unref();
let routingPolicy = normalizeRoutingPolicy(await store.load('routing-policy', DEFAULT_ROUTING_POLICY));
if (validateRoutingPolicy(routingPolicy)) routingPolicy = normalizeRoutingPolicy(DEFAULT_ROUTING_POLICY);
// Contador volátil de balanceamento: não persiste estado nem afeta quotas ou cobrança.
const balanceCursors = new Map();
let usageRetention = normalizeUsageRetention(await store.load('usage-retention', DEFAULT_USAGE_RETENTION));
if (validateUsageRetention(usageRetention)) usageRetention = { ...DEFAULT_USAGE_RETENTION };
let lastUsagePruneAt = 0;
async function pruneUsageIfDue(force = false) {
  if (usageRetention.retentionHours === null) return 0;
  const now = Date.now();
  if (!force && now - lastUsagePruneAt < 3600000) return 0;
  lastUsagePruneAt = now;
  try { return await usageStore.prune(usageRetention.retentionHours, new Date(now).toISOString()); }
  catch (error) { console.error('Falha ao aplicar retenção de uso:', error.message); return 0; }
}
if (process.env.NODE_ENV !== 'test') {
  const timer = setInterval(() => void pruneUsageIfDue(true), 3600000);
  timer.unref();
}
let routeAudit = await store.load('route-audit', []);
if (!Array.isArray(routeAudit)) throw new Error('Auditoria de rotas inválida');
let reconciliations = await store.load('usage-reconciliations', []);
if (!Array.isArray(reconciliations)) throw new Error('Conciliações de uso inválidas');
let reconciliationAudit = await store.load('usage-reconciliation-audit', []);
if (!Array.isArray(reconciliationAudit)) throw new Error('Auditoria de conciliação inválida');
let readinessOverrides = await store.load('provider-readiness', []);
if (!Array.isArray(readinessOverrides)) throw new Error('Homologação de fornecedores inválida');
let readinessPolicy = { ...DEFAULT_READINESS_POLICY, ...(await store.load('provider-readiness-policy', DEFAULT_READINESS_POLICY)) };
let readinessAudit = await store.load('provider-readiness-audit', []);
if (!Array.isArray(readinessAudit)) throw new Error('Auditoria de homologação inválida');
let selfServiceAudit = await store.load('client-self-service-audit', []);
if (!Array.isArray(selfServiceAudit)) throw new Error('Auditoria do cliente inválida');
let referrals = await store.load('referrals', []);
if (!Array.isArray(referrals)) throw new Error('Indicações inválidas');
let referralAudit = await store.load('referral-audit', []);
if (!Array.isArray(referralAudit)) throw new Error('Auditoria de indicações inválida');
let referralCodes = await store.load('referral-codes', {});
// Admin por usuário e senha. ANUBIS_ADMIN_USER/ANUBIS_ADMIN_PASSWORD só criam a primeira conta; a troca de senha é feita no painel.
// A chave ANUBIS_ADMIN_KEY continua valendo para scripts e acesso de emergência.
const ADMIN_SESSION_TTL_MS = 12 * 3600_000;
// Cotação do dólar só para estimativas em reais no admin; a cobrança continua em USD.
let fxConfig = normalizeFxConfig(await store.load('fx-config', DEFAULT_FX_CONFIG));
const fx = createFx();
let adminAccounts = await store.load('admin-accounts', []);
let adminSessions = await store.load('admin-sessions', []);
if (!adminAccounts.length && process.env.ANUBIS_ADMIN_USER && process.env.ANUBIS_ADMIN_PASSWORD) {
  adminAccounts = [{ id: randomUUID(), username: process.env.ANUBIS_ADMIN_USER.trim().toLowerCase(), passwordHash: hashPassword(process.env.ANUBIS_ADMIN_PASSWORD), createdAt: new Date().toISOString(), passwordChangedAt: null }];
  await store.save('admin-accounts', adminAccounts);
  console.warn(`Conta de admin "${adminAccounts[0].username}" criada a partir das variáveis de ambiente.`);
}
const adminLoginLimit = createLimiter(10, 15 * 60_000);
function adminSessionFor(req) {
  const token = /^Bearer (anubis_adm_.+)$/i.exec(req.headers.authorization || '')?.[1];
  if (!token) return null;
  const hash = tokenHash(token);
  const session = adminSessions.find(item => item.hash === hash && Date.parse(item.expiresAt) > Date.now());
  return session ? { session, account: adminAccounts.find(a => a.id === session.accountId) || null } : null;
}
// Contas de cliente (cadastro, confirmação por e-mail e login). Tokens e sessões ficam apenas como hash.
let accounts = await store.load('accounts', []);
let accountTokens = await store.load('account-tokens', []);
let accountSessions = await store.load('account-sessions', []);
const mailer = await createMailer();
const siteUrl = (process.env.ANUBIS_SITE_URL || (process.env.ANUBIS_PUBLIC_URL || '').split(',')[0] || 'https://anubisrouter.com').trim().replace(/\/+$/, '');
const authLimits = { login: createLimiter(10, 15 * 60_000), signup: createLimiter(5, 3600_000), email: createLimiter(3, 3600_000) };
// Playground anônimo: só modelos grátis, algumas mensagens por IP em 24h e um teto diário global.
const PLAYGROUND_MODELS = (process.env.PLAYGROUND_MODELS || 'anubis/gpt-5-codex:free,anubis/deepseek-v4.1-flash:free,anubis/qwen3.8-flash:free,anubis/mimo-v2.5:free').split(',').map(item => item.trim()).filter(Boolean);
const PLAYGROUND_FREE_MESSAGES = Math.max(0, Number(process.env.PLAYGROUND_FREE_MESSAGES ?? 10) || 0);
const PLAYGROUND_DAILY_CAP = Math.max(1, Number(process.env.PLAYGROUND_DAILY_CAP ?? 3000) || 3000);
const PLAYGROUND_KEY = Object.freeze({ id: 'playground', name: 'Playground anônimo', prefix: 'playground', active: true, planId: null });
const playgroundByIp = createLimiter(PLAYGROUND_FREE_MESSAGES, 24 * 3600_000);
const playgroundAll = createLimiter(PLAYGROUND_DAILY_CAP, 24 * 3600_000);
function clientIp(req) {
  // O proxy da hospedagem acrescenta o IP real ao fim de X-Forwarded-For; entradas anteriores vêm do cliente.
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(item => item.trim()).filter(Boolean);
  return forwarded.at(-1) || req.socket?.remoteAddress || 'desconhecido';
}
if (!referralCodes || typeof referralCodes !== 'object' || Array.isArray(referralCodes)) referralCodes = {};
// Preço original (tabela do fabricante) por ID público: só exibição e comparação, nunca entra na cobrança.
let originalPrices = await store.load('model-original-prices', {});
if (!originalPrices || typeof originalPrices !== 'object' || Array.isArray(originalPrices)) originalPrices = {};
let priceHistory = await store.load('price-history', null);
if (!Array.isArray(priceHistory)) {
  // Instalações anteriores não tinham histórico: fixa o que estava vigente como linha de base.
  priceHistory = [
    { id: 'baseline-default', scope: 'default', multiplier: pricingConfig.defaultMultiplier, effectiveAt: null },
    ...pricingConfig.rules.filter(r => r?.multiplier).map(r => ({ id: `baseline-model-${r.provider}-${r.model}`, scope: 'model', provider: r.provider, model: r.model, multiplier: r.multiplier, effectiveAt: null })),
    ...pricingConfig.manualPrices.filter(r => r?.price).map(r => ({ id: `baseline-manual-${r.provider}-${r.model}`, scope: 'manual', provider: r.provider, model: r.model, price: r.price, effectiveAt: null })),
    ...plans.filter(p => p?.multiplier).map(p => ({ id: `baseline-plan-${p.id}`, scope: 'plan', planId: p.id, multiplier: p.multiplier, effectiveAt: null })),
  ];
  await store.save('price-history', priceHistory);
}
function encrypt(value) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decrypt(value) {
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
if (credentials.xkiro) { try { decrypt(credentials.xkiro); } catch { console.error('Não foi possível abrir as credenciais: verifique ANUBIS_ENCRYPTION_KEY.'); process.exit(1); } }
// Preserva a credencial anterior e a rota padrão durante a migração para múltiplas chaves.
if (!Array.isArray(credentials.connections)) credentials.connections = credentials.xkiro ? [{ id: 'legacy-xkiro', provider: 'xkiro', name: 'xKiro anterior', secret: credentials.xkiro, status: 'unverified', models: [] }] : [];
for (const item of credentials.connections) { try { decrypt(item.secret); } catch { console.error('Não foi possível abrir as credenciais: verifique ANUBIS_ENCRYPTION_KEY.'); process.exit(1); } }
const digest = value => createHash('sha256').update(value).digest('hex');
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(16).toString('hex'));
// Sessões emitidas pelo admin para usar chaves cadastradas no chat/área do cliente sem devolver a chave:
// o valor original só existe no momento da criação, como hash; aqui guardamos apenas um token volátil em memória.
const CLIENT_SESSION_TTL_MS = 30 * 60 * 1000;
const clientSessions = new Map();
function pruneClientSessions(now = Date.now()) {
  for (const [token, session] of clientSessions) if (session.expiresAt <= now) clientSessions.delete(token);
}
function revokeClientSessionsFor(keyId) {
  for (const [token, session] of clientSessions) if (session.keyId === keyId) clientSessions.delete(token);
}
function presentedKey(req) { return /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1] || req.headers['x-api-key']; }
function clientForRequest(req) {
  const value = presentedKey(req);
  if (typeof value !== 'string') return null;
  const now = Date.now();
  pruneClientSessions(now);
  const session = clientSessions.get(value);
  if (session) {
    const key = clientKeys.find(k => k.id === session.keyId && k.active);
    if (!key) { clientSessions.delete(value); return null; }
    session.expiresAt = now + CLIENT_SESSION_TTL_MS;
    return key;
  }
  if (value.startsWith('anubis_acct_')) return accountSessionKey(value, now);
  return clientKeys.find(k => k.active && equal(k.hash, digest(value))) || null;
}
function accountSession(value, now = Date.now()) {
  const hash = tokenHash(value);
  const session = accountSessions.find(item => item.hash === hash);
  if (!session || Date.parse(session.expiresAt) <= now) return null;
  const account = accounts.find(item => item.id === session.accountId && !item.disabled);
  return account ? { session, account } : null;
}
function accountSessionKey(value, now = Date.now()) {
  const found = accountSession(value, now);
  return found?.account.keyId ? clientKeys.find(k => k.id === found.account.keyId && k.active) || null : null;
}
async function openAccountSession(account) {
  const token = newToken('anubis_acct_');
  const now = Date.now();
  const item = { hash: tokenHash(token), accountId: account.id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_TTL_MS).toISOString() };
  await mutate(async () => {
    const next = [...accountSessions.filter(s => Date.parse(s.expiresAt) > now), item].slice(-20_000);
    await store.save('account-sessions', next); accountSessions = next;
  });
  return { token, expiresAt: item.expiresAt };
}
/** Conta confirmada sem chave recebe uma chave raiz no plano de créditos; o valor da chave raiz nunca é exibido. */
async function ensureAccountKey(account) {
  if (account.keyId && clientKeys.some(k => k.id === account.keyId)) return account;
  const value = `anubis_${randomBytes(32).toString('base64url')}`;
  const key = { id: randomUUID(), name: account.username, prefix: value.slice(0, 15), hash: digest(value), active: true, createdAt: new Date().toISOString(), planId: CREDIT_PLAN.id };
  await mutate(async () => {
    const keys = [...clientKeys, key]; await store.save('api-keys', keys); clientKeys = keys;
    referralCodes[key.id] = makeReferralCode(); await store.save('referral-codes', referralCodes);
    const list = accounts.map(a => a.id === account.id ? { ...a, keyId: key.id } : a); await store.save('accounts', list); accounts = list;
  });
  return accounts.find(a => a.id === account.id);
}
async function sendAccountEmail(account, type) {
  const issued = issueEmailToken(accountTokens, { accountId: account.id, type });
  await mutate(async () => { await store.save('account-tokens', issued.tokens); accountTokens = issued.tokens; });
  const link = `${siteUrl}/${type === 'verify' ? 'confirmar' : 'entrar'}?token=${encodeURIComponent(issued.value)}`;
  try { return (await mailer.send(account.email, type, { username: account.username, link })).sent; }
  catch (error) { console.log(`E-mail ${type} para a conta ${account.id} falhou: ${error.code || error.message}`); return false; }
}
let writeQueue = Promise.resolve();
function mutate(fn) { const next = writeQueue.then(fn); writeQueue = next.catch(() => {}); return next; }
async function ensureReferralCodes() {
  let changed = false;
  for (const key of clientKeys) {
    if (key.parentId || referralCodes[key.id]) continue;
    referralCodes[key.id] = makeReferralCode();
    changed = true;
  }
  if (changed) await store.save('referral-codes', referralCodes);
}
await ensureReferralCodes();
async function appendPriceVersion(version) {
  priceHistory.push({ id: randomUUID(), effectiveAt: new Date().toISOString(), ...version });
  await store.save('price-history', priceHistory);
}
/** Média de custo dos fornecedores ativos de um ID público e a rota cuja regra de preço vale para ele. */
function referenceFor(publicModel) {
  if (!publicModel) return null;
  return modelPricing({ routes: routes.filter(r => r.id === publicModel), connectionForRoute, resolve: () => ({}) })[0] || null;
}
function saleSnapshotFor(startedAt, provider, model, plan, publicModel = null) {
  // A venda é a mesma qualquer que seja o fornecedor usado: média de custo × regra do fornecedor de maior prioridade.
  const reference = referenceFor(publicModel);
  const ruleProvider = reference ? connectionForRoute(reference.route)?.provider || provider : provider;
  const ruleModel = reference ? reference.route.upstreamModel : model;
  const resolved = resolvePrices(priceHistory, startedAt || new Date().toISOString(), ruleProvider, ruleModel, plan?.id || null);
  return {
    multiplier: resolved.multiplier, manualPrice: resolved.manualPrice, versionIds: resolved.versionIds,
    referenceCost: reference?.referenceCost || null,
  };
}
async function recordLedgerCompletion(record) {
  const entry = buildLedgerEntry(record, record?.planId || null);
  if (!entry) return;
  await mutate(async () => { await entries.upsert('ledger', entry); ledger = upsertLedgerEntry(ledger, entry); });
}
/**
 * Decide um pedido de recarga. Aprovar cria a recarga uma única vez (idempotencyKey) e coloca no plano de créditos
 * as chaves da conta que estavam sem plano. Usado pelo admin e pela confirmação de pagamento assinada.
 */
async function decideTopupRequest(id, action, note = '', payment = null) {
  let result = null; let failure = null;
  await mutate(async () => {
    const current = topupRequests.find(item => item.id === id);
    if (!current) { failure = [404, 'Pedido não encontrado.']; return; }
    if (current.status !== 'pending') { failure = [409, 'Este pedido já foi decidido.']; result = current; return; }
    const decidedAt = new Date().toISOString();
    let updated;
    if (action === 'approve') {
      const owner = clientKeys.find(key => key.id === current.keyId);
      if (!owner || owner.active === false) { failure = [400, 'A conta deste pedido está revogada.']; return; }
      const topup = { id: randomUUID(), keyId: current.keyId, amount: current.amount, currency: current.currency, note: note || 'Recarga solicitada pelo cliente', idempotencyKey: `request-${current.id}`, planId: owner.planId || null, createdAt: decidedAt, requestId: current.id, payment };
      await entries.upsert('topups', topup); topups = [...topups, topup];
      // Quem compra crédito passa a ser cobrado pelo saldo: chaves da conta sem plano entram no plano de créditos.
      if (clientKeys.some(key => (key.id === owner.id || key.parentId === owner.id) && !key.planId)) {
        const nextKeys = clientKeys.map(key => (key.id === owner.id || key.parentId === owner.id) && !key.planId ? { ...key, planId: CREDIT_PLAN.id } : key);
        await store.save('api-keys', nextKeys); clientKeys = nextKeys;
      }
      updated = { ...current, status: 'approved', decidedAt, topupId: topup.id, note: note || null, payment };
    } else {
      updated = { ...current, status: 'rejected', decidedAt, reason: note || 'Pagamento não confirmado.' };
    }
    await entries.upsert('topup-requests', updated);
    topupRequests = topupRequests.map(item => item.id === current.id ? updated : item); result = updated;
  });
  const wallet = result ? buildWallets(clientKeys, plans, topups, ledger).find(item => item.keyId === result.keyId) || null : null;
  return { failure, request: result, wallet };
}
function routeAuditEvent(action, target, before, after, detail = null) {
  return { id: randomUUID(), ...buildRouteAudit(action, target, before, after, detail) };
}
function routeChangeAction(existing, enabled) {
  if (!existing) return enabled ? 'route_enable' : 'route_create';
  if (existing.enabled === enabled) return 'route_update';
  return enabled ? 'route_enable' : 'route_disable';
}
// Chamado dentro de mutate: a auditoria vai na mesma escrita da mudança de rota.
async function appendRouteAudit(events) {
  routeAudit.push(...events);
  if (routeAudit.length > 500) routeAudit = routeAudit.slice(-500);
  await store.save('route-audit', routeAudit);
}
async function coolDownRoute(route, detail) {
  if (!Number.isSafeInteger(routingPolicy.cooldownMs) || routingPolicy.cooldownMs <= 0) return;
  const updated = { ...route, cooldownUntil: new Date(Date.now() + routingPolicy.cooldownMs).toISOString() };
  const event = routeAuditEvent('cooldown', route.id, route, updated, detail);
  await mutate(async () => {
    await saveRoutes(routes.map(item => item.destinationId === route.destinationId ? updated : item));
    await appendRouteAudit([event]);
  });
}
function periodFrom(url) {
  return parsePeriod({ from: url.searchParams.get('from'), to: url.searchParams.get('to') });
}
function readinessReport() {
  return {
    providers: connectors.map(profile => buildReadiness(profile, readinessOverrides, readinessPolicy)),
    policy: { enforceResale: readinessPolicy.enforceResale === true },
    audit: readinessAudit.slice(-50),
  };
}
function commercialGate(provider) {
  return commercialBlock(provider, readinessReport().providers, readinessPolicy);
}
function appendReadinessAudit(event) {
  readinessAudit.push(event);
  if (readinessAudit.length > 500) readinessAudit = readinessAudit.slice(-500);
}
function appendSelfServiceAudit(event) {
  selfServiceAudit.push(event);
  if (selfServiceAudit.length > 500) selfServiceAudit = selfServiceAudit.slice(-500);
}
function appendReferralAudit(event) {
  referralAudit.push(event);
  if (referralAudit.length > 500) referralAudit = referralAudit.slice(-500);
}
// O link gerado usa apenas o Host validado da própria requisição; nunca lê variáveis de ambiente.
function referralBaseUrl(req) {
  const host = String(req.headers.host || '');
  const candidate = /^[\w.-]+(?::\d+)?$/.test(host) ? `http://${host}` : '';
  return candidate && allowedOrigins.has(candidate) ? candidate : `http://127.0.0.1:${port}`;
}

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function authorized(req, expected) {
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1];
  return equal(bearer, expected) || equal(req.headers['x-api-key'], expected);
}
function json(res, status, value) {
  const text = JSON.stringify(value);
  traffic.noteResponseBytes(Buffer.byteLength(text));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}
async function body(req, onBytes) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('Corpo excede 8 MB'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    onBytes?.(size);
  }
}
function validRoute(route) {
  return route && typeof route.id === 'string' && /^[\w./:-]{1,160}$/.test(route.id) && !!connector(route.provider) && typeof route.upstreamModel === 'string' && /^[\w./:-]{1,160}$/.test(route.upstreamModel) && typeof route.enabled === 'boolean';
}
function originFor(c) {
  if (process.env.NODE_ENV === 'test' && process.env.TEST_UPSTREAM_URL) return process.env.TEST_UPSTREAM_URL;
  return c.provider === 'generic' ? c.base : (c.provider === 'xkiro' ? upstream : connector(c.provider)?.base);
}
function safeConnection(c) { return { id: c.id, name: c.name, provider: c.provider, base: c.provider === 'generic' ? c.base : connector(c.provider)?.base, validationPath: connector(c.provider)?.validation || c.validationPath || '', status: c.status, active: c.active !== false, checkedAt: c.checkedAt, modelCount: c.models?.length || 0, priceSource: c.priceSource || null }; }
function connectionForRoute(route) { return credentials.connections.find(c => c.id === (route.connectionId || (route.provider === 'xkiro' ? 'legacy-xkiro' : '')) && c.active !== false); }
function enabledModelIds() { return [...new Set(routes.filter(r => r.enabled && connectionForRoute(r)).map(r => r.id))]; }
// Uso agregado por conexão: a franquia do fornecedor é compartilhada entre chaves, não dividida por chave.
function providerDayTokens(records, connectionId, day) {
  const seen = new Set(); let tokens = 0;
  for (const record of records) {
    if (record.connectionId !== connectionId || !['completed', 'cancelled'].includes(record.status)) continue;
    const at = record.startedAt || record.finishedAt;
    if (!at || at < day.start || at >= day.end) continue;
    const id = record.requestId || record.id; if (id && seen.has(id)) continue; if (id) seen.add(id);
    for (const field of ['inputTokens', 'outputTokens']) { const value = record.usage?.[field]; if (Number.isSafeInteger(value) && value >= 0) tokens += value; }
  }
  return tokens;
}
function providerQuotaUsage(records) {
  const window = monthWindow(); const day = dayWindow();
  return credentials.connections.filter(c => c.active !== false).map(c => {
    const seen = new Set(); let tokens = 0;
    for (const record of records) {
      if (record.connectionId !== c.id || record.status !== 'completed') continue;
      const at = record.startedAt || record.finishedAt;
      if (!at || at < window.start || at >= window.end) continue;
      seen.add(record.requestId || record.id);
      for (const field of ['inputTokens', 'outputTokens']) {
        const value = record.usage?.[field];
        if (Number.isSafeInteger(value) && value >= 0) tokens += value;
      }
    }
    const account = providerAccounts.find(a => a.connectionId === c.id) || null;
    return { connectionId: c.id, name: c.name, provider: c.provider, requests: seen.size, tokens, window, dayTokens: providerDayTokens(records, c.id, day), dailyLimit: account?.dailyTokens ?? null, backup: account?.backup === true };
  });
}
function normalizePlan(data, existing) {
  const limit = value => (value === '' || value === null || value === undefined) ? null : (typeof value === 'number' ? value : Number(value));
  return {
    id: existing?.id || randomUUID(),
    name: typeof data.name === 'string' ? data.name.trim() : '',
    kind: data.kind,
    monthlyRequests: limit(data.monthlyRequests),
    monthlyTokens: limit(data.monthlyTokens),
    dailyRequests: limit(data.dailyRequests),
    dailyTokens: limit(data.dailyTokens),
    models: Array.isArray(data.models) ? data.models.filter(id => typeof id === 'string') : [],
    multiplier: data.multiplier === '' || data.multiplier === undefined ? null : data.multiplier,
    currency: data.kind === 'payg' && typeof data.currency === 'string' ? data.currency.trim().toUpperCase() : null,
    active: data.active !== false,
    // Plano só aparece na área do cliente quando o admin habilita; o plano gratuito padrão já vem habilitado.
    selfService: data.selfService === true || (!existing && data.id === 'free'),
  };
}
async function fetchMaxRouterPrices() {
  // Em testes, o mock local substitui a página pública; em produção a URL é fixa no código.
  const url = process.env.NODE_ENV === 'test' && process.env.TEST_UPSTREAM_URL
    ? `${process.env.TEST_UPSTREAM_URL.replace(/\/+$/, '')}/api/v1/models`
    : MAXROUTER_PRICING_URL;
  const response = await providerFetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Preços públicos indisponíveis (HTTP ${response.status})`);
  return parseMaxRouterPrices(await response.json());
}
async function fetchCatalog(c, secret) {
  const profile = connector(c.provider); const catalogPath = c.provider === 'generic' ? '/v1/models' : profile.catalog;
  if (!catalogPath) return [];
  const response = await providerFetch(originFor(c) + catalogPath, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Catálogo indisponível (HTTP ${response.status})`);
  const data = await response.json(); const items = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : data.data?.models);
  if (!Array.isArray(items)) throw new Error('Formato de catálogo não reconhecido');
  const isMaxRouter = c.provider === 'maxrouter';
  let publicPrices = new Map(); let priceFetchFailed = false;
  if (isMaxRouter) {
    try {
      const fetched = await fetchMaxRouterPrices();
      if (!fetched.size) throw new Error('Catálogo público de preços vazio');
      publicPrices = fetched;
    } catch { priceFetchFailed = true; }
  }
  const previousById = new Map((Array.isArray(c.models) ? c.models : []).map(m => [m.id, m]));
  return items.filter(m => m && typeof (m.id || m.slug) === 'string' && /^[\w./:-]{1,160}$/.test(m.id || m.slug)).slice(0, 5000).map(m => {
    const id = m.id || m.slug; const previous = previousById.get(id); const publicPrice = publicPrices.get(id);
    const previousPrice = previous?.pricing?.source === MAXROUTER_PRICING_PAGE ? previous.pricing : null;
    // No MaxRouter, o custo vem apenas do snapshot público; o catálogo autenticado não informa preço.
    // Se a busca falhar, preserva o snapshot anterior como stale; se o preço saiu do catálogo, não o ressuscita.
    const pricing = isMaxRouter
      ? (priceFetchFailed ? (previousPrice ? { ...previousPrice, stale: true } : null) : publicPrice || null)
      : (m.pricing || m.price || null);
    return {
      id, name: String(m.display_name || m.displayName || m.name || id).slice(0, 240),
      family: m.provider || m.owned_by || null, modality: m.modality || 'chat',
      access: m.access_tier || null, planOnly: m.plan_only === true, pricing,
      billingType: m.billing_type || (publicPrice ? 'token' : previous?.billingType || null),
      context: m.context_length || m.context_window || m.contextLength || null, capabilities: m.capabilities || null,
      priceSource: pricing?.source === MAXROUTER_PRICING_PAGE ? { page: pricing.source, data: pricing.sourceData, capturedAt: pricing.capturedAt, stale: pricing.stale === true } : null,
      priceStale: isMaxRouter && pricing?.source === MAXROUTER_PRICING_PAGE ? pricing.stale === true : false,
    };
  });
}
function summarizePriceSource(models) {
  const priced = (Array.isArray(models) ? models : []).filter(m => m?.priceSource?.page === MAXROUTER_PRICING_PAGE);
  if (!priced.length) return null;
  const first = priced[0].priceSource;
  return { page: first.page, data: first.data, capturedAt: first.capturedAt, count: priced.length, stale: priced.some(m => m.priceStale) };
}
async function checkConnection(c, secret) {
  const profile = connector(c.provider);
  const models = async () => {
    const list = await fetchCatalog(c, secret);
    return { models: list, priceSource: summarizePriceSource(list) };
  };
  const endpoint = profile.validation || c.validationPath;
  // Fornecedor com catálogo público: a chave só se prova numa chamada real, de 1 token, a um modelo grátis.
  if (!endpoint && profile.validationChat) {
    const response = await providerFetch(originFor(c) + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: profile.validationChat, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Credencial não validada (HTTP ${response.status})`);
    await response.body?.cancel();
    return { status: 'valid', ...(await models()) };
  }
  if (!endpoint) return { status: 'unverified', ...(await models()) };
  const response = await providerFetch(originFor(c) + endpoint, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Credencial não validada (HTTP ${response.status})`);
  await response.body?.cancel();
  return { status: profile.authenticatedValidation ? 'valid' : 'endpoint_accepted', ...(await models()) };
}
async function saveRoutes(next) {
  await store.save('routes', next); routes = next;
}
let publicCatalogCache = null;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // A API não deve ser indexada por buscadores.
    res.setHeader('x-robots-tag', 'noindex, nofollow');
    if (req.method === 'GET' && url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('User-agent: *\nDisallow: /\n');
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return json(res, 403, { error: 'Origem não permitida' });
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key');
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end();
    }
    // Transição: o painel e o site têm servidores próprios; aqui o config.js mantém as cópias de teste funcionando.
    if (req.method === 'GET' && url.pathname === '/config.js') {
      const apiUrl = (process.env.ANUBIS_API_URL || '').replace(/\/+$/, '');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(`window.ANUBIS_API_URL = ${JSON.stringify(apiUrl)};\n`);
    }
    const pages = ['/', '/models', '/providers', '/routes', '/plans', '/ledger', '/topup', '/keys', '/users', '/stats', '/global-stats', '/client-home', '/system', '/connect', '/chat', '/minha-conta', '/referrals', '/indicacoes'];
    // Chat, área do cliente e indicações são seções do mesmo painel; todas as URLs servem o index.html.
    const assets = ['/app.js', '/style.css', '/panel-extras.css', '/brand.png', '/connect-tools.json', '/chat-web.js', '/chat-sse.js', '/account.js', '/referrals-client.js'];
    if (req.method === 'GET' && (pages.includes(url.pathname) || assets.includes(url.pathname))) {
      const file = pages.includes(url.pathname) ? 'index.html' : url.pathname.slice(1);
      let content;
      try { content = await readFile(webFile(path.join('public', file))); }
      catch (e) { if (e.code === 'ENOENT') return json(res, 404, { error: 'Interface não disponível nesta instalação da API' }); throw e; }
      const mime = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : file.endsWith('.json') ? 'application/json' : 'text/css';
      res.writeHead(200, { 'content-type': `${mime}; charset=utf-8`, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
      return res.end(content);
    }
    if (req.method === 'POST' && url.pathname === '/admin/login') {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
      if (!adminLoginLimit.take(tokenHash(clientIp(req)))) return json(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
      let data; try { data = await body(req); } catch { return json(res, 400, { error: 'Corpo inválido.' }); }
      const username = typeof data?.username === 'string' ? data.username.trim().toLowerCase() : '';
      const account = adminAccounts.find(a => a.username === username) || null;
      const valid = verifyPassword(typeof data?.password === 'string' ? data.password : '', account?.passwordHash || DUMMY_PASSWORD_HASH) && !!account;
      if (!valid) return json(res, 401, { error: 'Usuário ou senha incorretos.' });
      const token = newToken('anubis_adm_');
      const now = Date.now();
      const item = { hash: tokenHash(token), accountId: account.id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ADMIN_SESSION_TTL_MS).toISOString() };
      await mutate(async () => { const next = [...adminSessions.filter(x => Date.parse(x.expiresAt) > now), item].slice(-500); await store.save('admin-sessions', next); adminSessions = next; });
      return json(res, 200, { token, expiresAt: item.expiresAt, username: account.username });
    }
    if (url.pathname.startsWith('/admin/')) {
      const adminSession = adminSessionFor(req);
      if (!adminSession && !authorized(req, adminKey)) return json(res, 401, { error: 'Sessão administrativa inválida. Entre novamente.' });
      if (req.method === 'POST' && url.pathname === '/admin/logout') {
        if (adminSession) await mutate(async () => { const next = adminSessions.filter(x => x !== adminSession.session); await store.save('admin-sessions', next); adminSessions = next; });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/admin/fx') return json(res, 200, await fx.current(fxConfig));
      if (req.method === 'POST' && url.pathname === '/admin/fx') {
        let data; try { data = await body(req); } catch { return json(res, 400, { error: 'Corpo inválido.' }); }
        const invalid = validateFxConfig(data);
        if (invalid) return json(res, 400, { error: invalid });
        const next = normalizeFxConfig({ mode: data.mode, manualRate: data.mode === 'manual' ? String(data.manualRate).replace(',', '.') : fxConfig.manualRate });
        await mutate(async () => { await store.save('fx-config', next); fxConfig = next; });
        return json(res, 200, await fx.current(fxConfig));
      }
      if (req.method === 'GET' && url.pathname === '/admin/me') return json(res, 200, { username: adminSession?.account?.username || null, viaKey: !adminSession });
      if (req.method === 'POST' && url.pathname === '/admin/password') {
        if (!adminSession?.account) return json(res, 400, { error: 'Entre com usuário e senha para trocar a senha.' });
        let data; try { data = await body(req); } catch { return json(res, 400, { error: 'Corpo inválido.' }); }
        if (!verifyPassword(typeof data?.current === 'string' ? data.current : '', adminSession.account.passwordHash)) return json(res, 400, { error: 'Senha atual incorreta.' });
        const next = typeof data?.next === 'string' ? data.next : '';
        if (next.length < 10 || next.length > 200) return json(res, 400, { error: 'A nova senha deve ter de 10 a 200 caracteres.' });
        if (next.toLowerCase().includes(adminSession.account.username)) return json(res, 400, { error: 'A nova senha não pode conter o nome de usuário.' });
        let username = adminSession.account.username;
        if (typeof data?.username === 'string' && data.username.trim()) {
          username = data.username.trim().toLowerCase();
          if (!/^[a-z0-9._-]{3,32}$/.test(username)) return json(res, 400, { error: 'Usuário deve ter de 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.' });
        }
        await mutate(async () => {
          const accountsNext = adminAccounts.map(a => a.id === adminSession.account.id ? { ...a, username, passwordHash: hashPassword(next), passwordChangedAt: new Date().toISOString() } : a);
          await store.save('admin-accounts', accountsNext); adminAccounts = accountsNext;
          // Trocar a senha encerra as outras sessões do mesmo admin.
          const sessionsNext = adminSessions.filter(x => x.accountId !== adminSession.account.id || x === adminSession.session);
          await store.save('admin-sessions', sessionsNext); adminSessions = sessionsNext;
        });
        return json(res, 200, { ok: true, username });
      }
      if (req.method === 'GET' && url.pathname === '/admin/extension/info') {
        return json(res, 200, {
          version: extensionVersion, file: extensionFile, available: await extensionAvailable(),
          targets: extensionTargets.map(({ id, label, note, cli }) => ({ id, label, note, install: `${cli} --install-extension ${extensionFile}` })),
        });
      }
      if (req.method === 'GET' && url.pathname === '/admin/extension') {
        try {
          const artifact = await readFile(extensionPath);
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${extensionFile}"`,
            'x-anubis-extension-version': extensionVersion,
            'content-length': artifact.length,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
          });
          return res.end(artifact);
        } catch (error) {
          if (error?.code === 'ENOENT') return json(res, 404, { error: 'Extensão não disponível nesta instalação. Gere o VSIX em extension/ antes de publicar.' });
          throw error;
        }
      }
      if (req.method === 'GET' && url.pathname === '/admin/status') return json(res, 200, { provider: 'xkiro', configured: credentials.connections.some(c => c.provider === 'xkiro'), routes: routes.length });
      if (req.method === 'GET' && url.pathname === '/admin/system') return json(res, 200, await collectSystemReport({
        root, traffic, store, usageStore, retention: usageRetention,
        counts: {
          routesEnabled: routes.filter(r => r.enabled).length,
          connectionsActive: credentials.connections.filter(c => c.active !== false).length,
          keysActive: clientKeys.filter(k => k.active).length,
          plansCount: plans.length,
          routesCoolingDown: routes.filter(route => isCoolingDown(route)).length,
          balanceStrategy: routingPolicy.strategy,
        },
      }));
      if (req.method === 'GET' && url.pathname === '/admin/usage/retention') return json(res, 200, usageRetention);
      if (req.method === 'POST' && url.pathname === '/admin/usage/retention') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const next = normalizeUsageRetention(await body(req));
        const invalid = validateUsageRetention(next);
        if (invalid) return json(res, 400, { error: invalid });
        const deleted = await mutate(async () => { await store.save('usage-retention', next); usageRetention = next; return pruneUsageIfDue(true); });
        return json(res, 200, { ...usageRetention, deleted });
      }
      // Teste sem inferência: a chave temporária existe só em memória durante a checagem e nunca é gravada ou devolvida.
      if (req.method === 'POST' && url.pathname === '/admin/connect/diagnose') {
        const temporaryValue = `diagnostic-${randomUUID()}`;
        const temporaryKey = { id: `diagnostic-${randomUUID()}`, active: true, hash: digest(temporaryValue) };
        let auth = false;
        try {
          clientKeys.push(temporaryKey);
          auth = !!clientForRequest({ headers: { authorization: `Bearer ${temporaryValue}` } });
        } finally {
          clientKeys = clientKeys.filter(item => item !== temporaryKey);
        }
        return json(res, 200, buildConnectDiagnostic({
          auth,
          modelCount: enabledModelIds().length,
          routeCount: routes.filter(r => r.enabled).length,
          connectionCount: credentials.connections.filter(c => c.active !== false).length,
          keyCount: clientKeys.filter(k => k.active).length,
        }));
      }
      if (req.method === 'GET' && url.pathname === '/admin/connectors') return json(res, 200, { connectors });
      if (req.method === 'GET' && url.pathname === '/admin/provider-readiness') return json(res, 200, readinessReport());
      if (req.method === 'POST' && url.pathname === '/admin/provider-readiness') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        if (data.providerId === undefined && data.enforceResale !== undefined) {
          const next = { ...readinessPolicy, enforceResale: data.enforceResale === true, updatedAt: new Date().toISOString() };
          await mutate(async () => { await store.save('provider-readiness-policy', next); readinessPolicy = next; });
          return json(res, 200, readinessReport());
        }
        const profile = connector(data.providerId);
        const current = readinessOverrides.find(item => item?.providerId === data.providerId) || { providerId: data.providerId, status: 'planejado', resaleConfirmed: false };
        const next = normalizeReadinessUpdate(data, current);
        const invalid = validateReadinessUpdate(next, profile, current);
        if (invalid) return json(res, 400, { error: invalid });
        const event = {
          id: randomUUID(), at: new Date().toISOString(), actor: 'admin', providerId: next.providerId,
          before: { status: current.status || 'planejado', resaleConfirmed: current.resaleConfirmed === true, reviewedAt: current.reviewedAt || '' },
          after: { status: next.status, resaleConfirmed: next.resaleConfirmed === true, reviewedAt: next.reviewedAt || '' },
          reason: next.note || null,
        };
        let report;
        await mutate(async () => {
          readinessOverrides = [...readinessOverrides.filter(item => item?.providerId !== next.providerId), { ...next, updatedAt: event.at }];
          await store.save('provider-readiness', readinessOverrides);
          appendReadinessAudit(event);
          await store.save('provider-readiness-audit', readinessAudit);
          report = readinessReport();
        });
        return json(res, 200, report);
      }
      if (req.method === 'GET' && url.pathname === '/admin/pricing') return json(res, 200, pricingConfig);
      // Os três preços de cada modelo público: original (fabricante), custo por fornecedor e média, e venda ao cliente.
      if (req.method === 'GET' && url.pathname === '/admin/model-prices') {
        const at = new Date().toISOString();
        const items = modelPricing({ routes, connectionForRoute, originals: originalPrices, resolve: (provider, model) => resolvePrices(priceHistory, at, provider, model, null) });
        return json(res, 200, {
          targetSuppliers: 3, defaultMultiplier: pricingConfig.defaultMultiplier,
          models: items.map(item => ({
            id: item.id, name: item.route.name || item.providerModel?.name || item.id,
            suppliers: item.suppliers, supplierCount: item.suppliers.length,
            pricedSuppliers: item.referenceCost?.suppliers || 0,
            averageCost: item.referenceCost, multiplier: item.resolved.manualPrice ? null : item.resolved.multiplier || pricingConfig.defaultMultiplier,
            manual: !!item.resolved.manualPrice, sale: item.sale, original: item.original,
          })),
        });
      }
      if (req.method === 'POST' && url.pathname === '/admin/model-prices') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        if (typeof data.model !== 'string' || !/^[\w./:-]{1,160}$/.test(data.model)) return json(res, 400, { error: 'Modelo inválido.' });
        let saved = null;
        if (data.price !== null) {
          const price = data.price;
          if (!price || typeof price !== 'object' || !/^[A-Z]{3}$/.test(price.currency || 'USD')) return json(res, 400, { error: 'Moeda inválida.' });
          saved = { currency: price.currency || 'USD' };
          for (const field of ['request', 'input', 'output', 'cacheRead', 'cacheWrite']) {
            const value = price[field];
            if (value === undefined || value === null || value === '') continue;
            if (decimalUnits(String(value)) === null) return json(res, 400, { error: 'Informe valores não negativos.' });
            saved[field] = String(value);
          }
          if (Object.keys(saved).length === 1) return json(res, 400, { error: 'Informe ao menos um preço.' });
          saved.updatedAt = new Date().toISOString();
        }
        await mutate(async () => {
          const next = { ...originalPrices };
          if (saved) next[data.model] = saved; else delete next[data.model];
          await store.save('model-original-prices', next);
          originalPrices = next;
          publicCatalogCache = null;
        });
        return json(res, 200, { model: data.model, original: saved });
      }
      if (req.method === 'POST' && url.pathname === '/admin/pricing') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        const validMultiplier = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/.test(value) && Number(value) > 0;
        if (data.scope === 'default') {
          if (!validMultiplier(data.multiplier)) return json(res, 400, { error: 'Multiplicador deve ser maior que zero e ter até seis casas decimais.' });
          await mutate(async () => { const next = { ...pricingConfig, defaultMultiplier: data.multiplier }; await store.save('pricing-config', next); pricingConfig = next; await appendPriceVersion({ scope: 'default', multiplier: data.multiplier }); });
        } else if (data.scope === 'model') {
          if (!connector(data.provider) || typeof data.model !== 'string' || !/^[\w./:-]{1,160}$/.test(data.model) || (data.multiplier !== null && !validMultiplier(data.multiplier))) return json(res, 400, { error: 'Fornecedor, modelo ou multiplicador inválido.' });
          if (data.multiplier !== null) { const blocked = commercialGate(data.provider); if (blocked) return json(res, 403, { error: blocked }); }
          await mutate(async () => { const rules = pricingConfig.rules.filter(r => !(r.provider === data.provider && r.model === data.model)); if (data.multiplier !== null) rules.push({ provider: data.provider, model: data.model, multiplier: data.multiplier }); const next = { ...pricingConfig, rules }; await store.save('pricing-config', next); pricingConfig = next; await appendPriceVersion({ scope: 'model', provider: data.provider, model: data.model, multiplier: data.multiplier }); });
        } else if (data.scope === 'manual_model') {
          if (!connector(data.provider) || typeof data.model !== 'string' || !/^[\w./:-]{1,160}$/.test(data.model)) return json(res, 400, { error: 'Fornecedor ou modelo inválido.' });
          const price = data.price;
          if (price !== null) {
            const blocked = commercialGate(data.provider); if (blocked) return json(res, 403, { error: blocked });
            if (!price || !['per_1m_tokens', 'per_request'].includes(price.basis) || !/^[A-Z]{3}$/.test(price.currency || '')) return json(res, 400, { error: 'Moeda ou unidade de preço inválida.' });
            const required = price.basis === 'per_request' ? ['request'] : ['input', 'output'];
            const optional = price.basis === 'per_1m_tokens' ? ['cacheRead', 'cacheWrite'] : [];
            if (required.some(field => decimalUnits(price[field]) === null) || optional.some(field => price[field] !== undefined && price[field] !== '' && decimalUnits(price[field]) === null)) return json(res, 400, { error: 'Informe valores não negativos com até 12 casas decimais.' });
          }
          await mutate(async () => {
            const manualPrices = pricingConfig.manualPrices.filter(r => !(r.provider === data.provider && r.model === data.model));
            let savedPrice = null;
            if (price !== null) {
              const saved = { currency: price.currency, basis: price.basis };
              if (price.basis === 'per_request') saved.request = price.request;
              else {
                saved.input = price.input; saved.output = price.output;
                for (const field of ['cacheRead', 'cacheWrite']) if (price[field] !== undefined && price[field] !== '') saved[field] = price[field];
              }
              savedPrice = saved;
              manualPrices.push({ provider: data.provider, model: data.model, price: saved });
            }
            const next = { ...pricingConfig, manualPrices }; await store.save('pricing-config', next); pricingConfig = next;
            await appendPriceVersion({ scope: 'manual', provider: data.provider, model: data.model, price: savedPrice });
          });
        } else return json(res, 400, { error: 'Escopo de preço inválido.' });
        publicCatalogCache = null;
        return json(res, 200, pricingConfig);
      }
      if (req.method === 'GET' && url.pathname === '/admin/plans') return json(res, 200, { plans, defaultMultiplier: pricingConfig.defaultMultiplier, providerUsage: providerQuotaUsage(await usageStore.list()) });
      if (req.method === 'POST' && url.pathname === '/admin/plans') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        const existing = data.id ? plans.find(p => p.id === data.id) : null;
        if (data.id && !existing) return json(res, 404, { error: 'Plano não encontrado' });
        const plan = normalizePlan(data, existing);
        const invalid = validatePlan(plan);
        if (invalid) return json(res, 400, { error: invalid });
        await mutate(async () => {
          const next = existing ? plans.map(p => p.id === existing.id ? plan : p) : [...plans, plan];
          await store.save('plans', next); plans = next;
          if (!existing || existing.multiplier !== plan.multiplier) await appendPriceVersion({ scope: 'plan', planId: plan.id, multiplier: plan.multiplier });
        });
        return json(res, existing ? 200 : 201, { plan });
      }
      if (req.method === 'GET' && url.pathname === '/admin/ledger') return json(res, 200, { history: priceHistory, entries: ledger, summary: summarizeLedger(ledger, await usageStore.list()), scope: 'last_10000_requests' });
      if (req.method === 'POST' && url.pathname === '/admin/ledger/reconcile') {
        const records = await usageStore.list();
        const known = new Set(ledger.map(entry => entry?.id));
        let added = 0;
        await mutate(async () => {
          for (const record of records) {
            if (record?.status !== 'completed' || known.has(`led-${record.requestId}`)) continue;
            const entry = buildLedgerEntry(record, record.planId || null);
            if (!entry) continue;
            await entries.upsert('ledger', entry);
            ledger = upsertLedgerEntry(ledger, entry); known.add(entry.id); added++;
          }
        });
        return json(res, 200, { added, counts: summarizeLedger(ledger, records).counts });
      }
      if (req.method === 'GET' && url.pathname === '/admin/topup') return json(res, 200, { wallets: buildWallets(clientKeys, plans, topups, ledger), topups, scope: 'manual_topups' });
      if (req.method === 'POST' && url.pathname === '/admin/topup') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const topup = normalizeTopup(await body(req));
        const key = clientKeys.find(item => item.id === topup.keyId);
        const plan = plans.find(item => item.id === key?.planId) || null;
        const invalid = validateTopup(topup, key, plan);
        if (invalid) return json(res, 400, { error: invalid });
        let saved = null; let duplicate = false;
        await mutate(async () => {
          if (topup.idempotencyKey) {
            const existing = topups.find(item => item?.idempotencyKey === topup.idempotencyKey);
            if (existing) { saved = existing; duplicate = true; return; }
          }
          saved = { id: randomUUID(), ...topup, planId: plan?.id || null, createdAt: new Date().toISOString() };
          await entries.upsert('topups', saved); topups = [...topups, saved];
        });
        const wallet = buildWallets(clientKeys, plans, topups, ledger).find(item => item.keyId === topup.keyId) || null;
        return json(res, duplicate ? 200 : 201, { topup: saved, wallet, duplicate });
      }
      // Pedidos de recarga dos clientes: o admin confirma o pagamento e o valor entra como recarga na conta.
      if (req.method === 'GET' && url.pathname === '/admin/topup-requests') {
        const wallets = new Map(buildWallets(clientKeys, plans, topups, ledger).map(item => [item.keyId, item]));
        const items = [...topupRequests].sort((a, b) => (a.status === 'pending') === (b.status === 'pending') ? b.createdAt.localeCompare(a.createdAt) : a.status === 'pending' ? -1 : 1)
          .slice(0, 200).map(item => {
            const owner = clientKeys.find(key => key.id === item.keyId);
            return { ...item, keyName: owner?.name || 'Chave removida', keyLabel: owner?.prefix ? `${owner.prefix}••••••••` : '—', balance: wallets.get(item.keyId)?.balance ?? null };
          });
        return json(res, 200, { requests: items, pending: topupRequests.filter(item => item.status === 'pending').length });
      }
      const topupDecision = /^\/admin\/topup-requests\/([\w-]{1,80})\/(approve|reject)$/.exec(url.pathname);
      if (req.method === 'POST' && topupDecision) {
        const data = /^application\/json\b/i.test(req.headers['content-type'] || '') ? await body(req) : {};
        const note = typeof data.note === 'string' ? data.note.trim().slice(0, 160) : '';
        const outcome = await decideTopupRequest(topupDecision[1], topupDecision[2], note);
        if (outcome.failure) return json(res, outcome.failure[0], { error: outcome.failure[1] });
        return json(res, 200, { request: outcome.request, wallet: outcome.wallet });
      }
      // Indicações: apenas registro administrativo. Nenhum depósito é cobrado e nenhum crédito é pago.
      if (req.method === 'GET' && url.pathname === '/admin/referrals') {
        await ensureReferralCodes();
        return json(res, 200, { ...buildAdminReferralReport({ records: referrals, keys: clientKeys, now: new Date().toISOString(), codes: referralCodes }), audit: referralAudit.slice(-50) });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/admin/referrals')) {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        const now = new Date().toISOString();
        const rootIds = clientKeys.filter(key => !key.parentId && key.active !== false).map(key => key.id);
        if (url.pathname === '/admin/referrals') {
          const invalid = validateRegister({ ...data, createdAt: now }, rootIds);
          if (invalid) return json(res, 400, { error: invalid });
          const item = { ...normalizeReferral({ ...data, createdAt: now }), id: randomUUID(), ownerKeyId: data.ownerKeyId };
          item.createdAt = now;
          await mutate(async () => {
            referrals = [...referrals, item];
            await store.save('referrals', referrals);
            appendReferralAudit({ id: randomUUID(), at: now, actorKeyId: 'admin', action: 'register_referral', targetKeyId: item.id, ownerKeyId: item.ownerKeyId, before: null, after: { status: 'cadastro' }, reason: null });
            await store.save('referral-audit', referralAudit);
          });
          return json(res, 201, { referral: buildAdminReferralReport({ records: referrals, keys: clientKeys, now, codes: referralCodes }).records.find(record => record.id === item.id) });
        }
        if (url.pathname === '/admin/referrals/qualify') {
          const target = referrals.find(item => item.id === data?.id);
          if (!target) return json(res, 404, { error: 'Indicação não encontrada.' });
          const invalid = validateQualify(data, target, now);
          if (invalid) return json(res, 400, { error: invalid });
          let updated = null; let conflict = false;
          await mutate(async () => {
            const current = referrals.find(item => item.id === target.id);
            if (!current || !['cadastro', 'em_analise'].includes(current.status)) { conflict = true; return; }
            updated = applyQualify(current, data, referrals, now);
            referrals = referrals.map(item => item.id === updated.id ? updated : item);
            await store.save('referrals', referrals);
            appendReferralAudit({ id: randomUUID(), at: now, actorKeyId: 'admin', action: 'qualify_referral', targetKeyId: updated.id, ownerKeyId: updated.ownerKeyId, before: { status: current.status }, after: { status: updated.status, rewardAmount: updated.rewardAmount, rewardCurrency: updated.rewardCurrency, holdUntil: updated.holdUntil }, reason: safeText(data.reference, 80) || null });
            await store.save('referral-audit', referralAudit);
          });
          if (conflict) return json(res, 409, { error: 'Esta indicação já foi alterada.' });
          return json(res, 200, { referral: buildAdminReferralReport({ records: referrals, keys: clientKeys, now, codes: referralCodes }).records.find(record => record.id === updated.id) });
        }
        if (url.pathname === '/admin/referrals/status') {
          const target = referrals.find(item => item.id === data?.id);
          if (!target) return json(res, 404, { error: 'Indicação não encontrada.' });
          const invalid = validateStatus(data, target);
          if (invalid) return json(res, 400, { error: invalid });
          let updated = null; let conflict = false;
          await mutate(async () => {
            const current = referrals.find(item => item.id === target.id);
            if (!current || current.status === 'creditado') { conflict = true; return; }
            updated = applyStatus(current, data.status, now, data.reason);
            referrals = referrals.map(item => item.id === updated.id ? updated : item);
            await store.save('referrals', referrals);
            appendReferralAudit({ id: randomUUID(), at: now, actorKeyId: 'admin', action: 'review_referral', targetKeyId: updated.id, ownerKeyId: updated.ownerKeyId, before: { status: current.status }, after: { status: updated.status }, reason: safeText(data.reason) || null });
            await store.save('referral-audit', referralAudit);
          });
          if (conflict) return json(res, 409, { error: 'Esta indicação já foi alterada.' });
          return json(res, 200, { referral: buildAdminReferralReport({ records: referrals, keys: clientKeys, now, codes: referralCodes }).records.find(record => record.id === updated.id) });
        }
        if (url.pathname === '/admin/referrals/move-credit') {
          const ids = Array.isArray(data?.ids) ? data.ids : [];
          const invalid = validateMoveCredit(referrals, ids, null, now);
          if (invalid) return json(res, 400, { error: invalid });
          let conflict = false;
          await mutate(async () => {
            const invalidNow = validateMoveCredit(referrals, ids, null, now);
            if (invalidNow) { conflict = true; return; }
            const moved = new Set(ids);
            referrals = referrals.map(item => moved.has(item.id) ? { ...item, status: 'creditado', movedAt: now, reviewedAt: now } : item);
            await store.save('referrals', referrals);
            appendReferralAudit({ id: randomUUID(), at: now, actorKeyId: 'admin', action: 'move_referral_credit', targetKeyId: ids.length === 1 ? ids[0] : null, ownerKeyId: null, before: { status: 'qualificada', ids }, after: { status: 'creditado', ids }, reason: null });
            await store.save('referral-audit', referralAudit);
          });
          if (conflict) return json(res, 409, { error: 'As indicações selecionadas mudaram de status.' });
          return json(res, 200, { moved: ids.length, report: buildAdminReferralReport({ records: referrals, keys: clientKeys, now, codes: referralCodes }) });
        }
        return json(res, 404, { error: 'Rota não encontrada' });
      }
      // Disponibilidade por modelo: mesma lista e preços do /public/models, com o estado de cada fornecedor.
      if (req.method === 'GET' && url.pathname === '/admin/model-availability') {
        const now = Date.now();
        const data = buildAdminAvailability({ routes, connectionForRoute, connections: credentials.connections.map(safeConnection), records: await usageStore.list(), now, originals: originalPrices, resolve: (provider, model) => resolvePrices(priceHistory, new Date(now).toISOString(), provider, model, null) });
        return json(res, 200, { object: 'list', updatedAt: new Date(now).toISOString(), windowHours: 24, data });
      }
      if (req.method === 'GET' && url.pathname === '/admin/connections') return json(res, 200, { connections: credentials.connections.map(safeConnection) });
      if (req.method === 'GET' && url.pathname === '/admin/usage') {
        const period = periodFrom(url);
        if (period.error) return json(res, 400, { error: period.error });
        const records = filterByPeriod(await usageStore.list(), period);
        return json(res, 200, { ...summarizeUsage(records), period: { from: period.from, to: period.to } });
      }
      if (req.method === 'GET' && url.pathname === '/admin/client-summary') {
        const keyId = url.searchParams.get('keyId');
        const key = clientKeys.find(item => item.id === keyId);
        if (!key) return json(res, 400, { error: 'Chave de cliente inválida.' });
        return json(res, 200, buildClientHome({
          key, plan: plans.find(item => item.id === key.planId) || null,
          records: await usageStore.list(), entries: ledger, topups, plans, now: new Date().toISOString(),
        }));
      }
      if (req.method === 'GET' && url.pathname === '/admin/client-stats') {
        const period = periodFrom(url);
        if (period.error) return json(res, 400, { error: period.error });
        const keyId = url.searchParams.get('keyId');
        const key = clientKeys.find(item => item.id === keyId);
        if (!key) return json(res, 400, { error: 'Chave de cliente inválida.' });
        const report = buildClientStats({
          key, records: await usageStore.list(), entries: ledger, period, now: new Date().toISOString(),
        });
        if (report?.error) return json(res, 400, { error: report.error });
        return json(res, 200, report);
      }
      if (req.method === 'GET' && url.pathname === '/admin/usage/pending') {
        const period = periodFrom(url);
        if (period.error) return json(res, 400, { error: period.error });
        const includeResolved = ['true', '1', 'yes'].includes(String(url.searchParams.get('includeResolved') || '').toLowerCase());
        return json(res, 200, listPending(await usageStore.list(), reconciliations, period, { includeResolved }));
      }
      if (req.method === 'POST' && url.pathname === '/admin/usage/reconcile') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = normalizeReconciliation(await body(req));
        const existing = reconciliations.find(item => item?.recordId === data.recordId);
        if (existing) return json(res, 200, { annotation: existing, audit: reconciliationAudit, duplicate: true });
        const records = await usageStore.list();
        const invalid = validateReconciliation(data, records, reconciliations);
        if (invalid) return json(res, 400, { error: invalid });
        let result = null; let duplicate = false;
        await mutate(async () => {
          const repeated = reconciliations.find(item => item?.recordId === data.recordId);
          if (repeated) { result = { annotation: repeated }; duplicate = true; return; }
          result = applyReconciliation(data, records, reconciliations, new Date().toISOString());
          const next = [...reconciliations, result.annotation];
          await store.save('usage-reconciliations', next); reconciliations = next;
          reconciliationAudit.push(result.event);
          if (reconciliationAudit.length > 500) reconciliationAudit = reconciliationAudit.slice(-500);
          await store.save('usage-reconciliation-audit', reconciliationAudit);
          await usageStore.write(result.record);
        });
        return json(res, duplicate ? 200 : 201, { annotation: result.annotation, audit: reconciliationAudit, duplicate });
      }
      if (req.method === 'GET' && url.pathname === '/admin/gateway-failures') {
        const period = periodFrom(url);
        if (period.error) return json(res, 400, { error: period.error });
        const report = buildGlobalStats({
          keys: clientKeys, plans, records: await usageStore.list(), entries: ledger,
          topups, connections: credentials.connections.map(safeConnection), period, now: new Date().toISOString(),
        });
        if (report?.error) return json(res, 400, { error: report.error });
        return json(res, 200, { period: report.period, failureRate: report.failureRate, ...report.failures });
      }
      if (req.method === 'GET' && url.pathname === '/admin/global-stats') {
        const period = periodFrom(url);
        if (period.error) return json(res, 400, { error: period.error });
        const report = buildGlobalStats({
          keys: clientKeys, plans, records: await usageStore.list(), entries: ledger,
          topups, connections: credentials.connections.map(safeConnection), period, now: new Date().toISOString(),
          admin: { configured: !!adminKey, clientSessions: clientSessions.size },
        });
        if (report?.error) return json(res, 400, { error: report.error });
        return json(res, 200, report);
      }
      if (req.method === 'GET' && url.pathname === '/admin/model-analytics') {
        const period = periodFrom(url);
        if (period.error) return json(res, 400, { error: period.error });
        const model = url.searchParams.get('model');
        const report = buildModelAnalytics({
          keys: clientKeys, plans, records: await usageStore.list(), entries: ledger,
          routes, connections: credentials.connections.map(safeConnection),
          period, model, now: new Date().toISOString(),
          admin: { configured: !!adminKey, clientSessions: clientSessions.size },
        });
        if (report?.missing) return json(res, 404, { error: report.error });
        if (report?.error) return json(res, 400, { error: report.error });
        return json(res, 200, report);
      }
      if (req.method === 'GET' && url.pathname === '/admin/dashboard') return json(res, 200, { accounts: buildDashboard(credentials.connections.map(safeConnection), providerAccounts, await usageStore.list(), dayWindow()), scope: 'last_10000_requests' });
      if (req.method === 'POST' && url.pathname === '/admin/provider-accounts') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        if (!credentials.connections.some(c => c.id === data.connectionId)) return json(res, 404, { error: 'Conexão não encontrada' });
        const balance = data.balance === '' ? null : data.balance;
        const spent = data.spent === '' ? null : data.spent;
        if ((balance !== null && decimalUnits(balance) === null) || (spent !== null && decimalUnits(spent) === null) || !/^[A-Z]{3}$/.test(data.currency || '') || !['payg', 'subscription', 'unknown'].includes(data.billingMode) || typeof data.plan !== 'string' || data.plan.length > 80) return json(res, 400, { error: 'Confira valores, moeda, plano e tipo de cobrança.' });
        const freeEndsAt = data.freeEndsAt || null;
        if (freeEndsAt && (typeof freeEndsAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(freeEndsAt) || Number.isNaN(Date.parse(freeEndsAt)))) return json(res, 400, { error: 'Data de término inválida.' });
        const dailyTokens = data.dailyTokens === '' || data.dailyTokens === null || data.dailyTokens === undefined ? null : Number(data.dailyTokens);
        if (dailyTokens !== null && (!Number.isSafeInteger(dailyTokens) || dailyTokens < 1)) return json(res, 400, { error: 'Franquia diária de tokens deve ser um inteiro positivo.' });
        let account;
        await mutate(async () => {
          const now = new Date().toISOString(); const old = providerAccounts.find(a => a.connectionId === data.connectionId);
          const reset = !old || data.resetAnchor === true || old.balance !== balance || old.currency !== data.currency || old.billingMode !== data.billingMode;
          account = { connectionId: data.connectionId, balance, spent, currency: data.currency, billingMode: data.billingMode, plan: data.plan.trim(), freeEndsAt, dailyTokens, backup: data.backup === true, balanceAsOf: reset ? now : old.balanceAsOf, spentAsOf: !old || old.spent !== spent ? now : old.spentAsOf, updatedAt: now };
          const next = [...providerAccounts.filter(a => a.connectionId !== account.connectionId), account]; await store.save('provider-accounts', next); providerAccounts = next;
        });
        return json(res, 200, { account });
      }
      if (req.method === 'GET' && url.pathname === '/admin/providers/wusrouter/models') {
        try { const models = await fetchCatalog({ provider: 'wusrouter' }, ''); return json(res, 200, { models, source: 'public', authenticated: false }); }
        catch { return json(res, 502, { error: 'Não foi possível carregar o catálogo público do WusRouter.' }); }
      }
      const catalogMatch = /^\/admin\/connections\/([\w-]+)\/models$/.exec(url.pathname);
      if (req.method === 'GET' && catalogMatch) {
        const c = credentials.connections.find(item => item.id === catalogMatch[1]);
        if (!c) return json(res, 404, { error: 'Credencial não encontrada' });
        const enabled = new Set(routes.filter(r => r.connectionId === c.id && r.enabled).map(r => r.upstreamModel));
        return json(res, 200, { models: (c.models || []).map(m => ({ ...m, enabled: enabled.has(m.id) })) });
      }
      if (req.method === 'POST' && url.pathname === '/admin/connections') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req); const profile = connector(data.provider);
        if (!profile) return json(res, 400, { error: 'Conector aguardando especificação ou homologação' });
        if (CONNECTION_BLOCKED[data.provider]) return json(res, 400, { error: CONNECTION_BLOCKED[data.provider] });
        if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80 || typeof data.key !== 'string' || data.key.length < 10 || data.key.length > 1024) return json(res, 400, { error: 'Informe nome e chave válidos' });
        const base = data.provider === 'generic' ? String(data.base || '').replace(/\/+$/, '').replace(/\/v1$/, '') : profile.base;
        if (data.provider === 'generic' && !validBase(base)) return json(res, 400, { error: 'Informe uma URL HTTPS pública válida, sem credenciais, parâmetros ou porta personalizada' });
        const validationPath = data.validationPath || '';
        if (validationPath && (typeof validationPath !== 'string' || !/^\/[\w/.-]{1,160}$/.test(validationPath) || validationPath.includes('..'))) return json(res, 400, { error: 'Caminho de validação inválido' });
        const item = { id: randomUUID(), provider: data.provider, name: data.name.trim(), base, validationPath, secret: encrypt(data.key) };
        let result;
        try { result = await checkConnection(item, data.key); } catch (e) { return json(res, 400, { error: `Não foi possível validar ou consultar a conexão: ${e.message}` }); }
        Object.assign(item, result, { checkedAt: new Date().toISOString() });
        await mutate(async () => { const next = { ...credentials, connections: [...credentials.connections, item] }; await store.save('credentials', next); credentials = next; });
        return json(res, 201, { connection: safeConnection(item) });
      }
      const editMatch = /^\/admin\/connections\/([\w-]+)$/.exec(url.pathname);
      if (req.method === 'PATCH' && editMatch) {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        const current = credentials.connections.find(item => item.id === editMatch[1]);
        if (!current) return json(res, 404, { error: 'Credencial não encontrada' });
        const profile = connector(current.provider);
        if (data.provider !== undefined && data.provider !== current.provider) return json(res, 400, { error: 'O fornecedor de uma conexão não pode ser alterado; cadastre outra credencial.' });
        const name = data.name === undefined ? current.name : String(data.name).trim();
        if (!name || name.length > 80) return json(res, 400, { error: 'Informe um nome válido (até 80 caracteres)' });
        const base = current.provider === 'generic' ? String(data.base === undefined ? current.base : data.base).replace(/\/+$/, '').replace(/\/v1$/, '') : profile.base;
        if (current.provider === 'generic' && !validBase(base)) return json(res, 400, { error: 'Informe uma URL HTTPS pública válida, sem credenciais, parâmetros ou porta personalizada' });
        const validationPath = data.validationPath === undefined ? (current.validationPath || '') : data.validationPath;
        if (validationPath && (typeof validationPath !== 'string' || !/^\/[\w/.-]{1,160}$/.test(validationPath) || validationPath.includes('..'))) return json(res, 400, { error: 'Caminho de validação inválido' });
        const key = typeof data.key === 'string' ? data.key : '';
        if (key && (key.length < 10 || key.length > 1024)) return json(res, 400, { error: 'A chave deve ter entre 10 e 1024 caracteres' });
        const secret = key ? key : decrypt(current.secret);
        const candidate = { ...current, name, base, validationPath };
        const credentialsChanged = base !== current.base || validationPath !== (current.validationPath || '') || !!key;
        let result = {};
        if (credentialsChanged) {
          try { result = await checkConnection(candidate, secret); }
          catch (e) { return json(res, 400, { error: `Não foi possível validar a conexão alterada: ${e.message}` }); }
        }
        let updated = null;
        await mutate(async () => {
          const found = credentials.connections.find(item => item.id === current.id);
          if (!found) return;
          updated = { ...found, name, base, validationPath, secret: key ? encrypt(key) : found.secret, ...result, checkedAt: new Date().toISOString() };
          const next = { ...credentials, connections: credentials.connections.map(item => item.id === current.id ? updated : item) };
          await store.save('credentials', next); credentials = next;
        });
        if (!updated) return json(res, 404, { error: 'Credencial não encontrada' });
        return json(res, 200, { connection: safeConnection(updated) });
      }
      const refreshMatch = /^\/admin\/connections\/([\w-]+)\/refresh$/.exec(url.pathname);
      if (req.method === 'POST' && refreshMatch) {
        const c = credentials.connections.find(item => item.id === refreshMatch[1]); if (!c) return json(res, 404, { error: 'Credencial não encontrada' });
        let result; try { result = await checkConnection(c, decrypt(c.secret)); } catch (e) { return json(res, 400, { error: `Não foi possível validar ou atualizar: ${e.message}` }); }
        await mutate(async () => { const next = { ...credentials, connections: credentials.connections.map(item => item.id === c.id ? { ...item, ...result, checkedAt: new Date().toISOString() } : item) }; await store.save('credentials', next); credentials = next; });
        return json(res, 200, { connection: safeConnection(credentials.connections.find(item => item.id === c.id)) });
      }
      const providerUsageMatch = /^\/admin\/connections\/([\w-]+)\/provider-usage$/.exec(url.pathname);
      if (req.method === 'POST' && providerUsageMatch) {
        const c = credentials.connections.find(item => item.id === providerUsageMatch[1]);
        if (!c) return json(res, 404, { error: 'Conexão não encontrada' });
        if (c.provider !== 'xkiro') return json(res, 400, { error: 'Consulta de saldo ainda não disponível para este fornecedor' });
        try {
          const response = await providerFetch(originFor(c) + '/v1/usage', { headers: { authorization: `Bearer ${decrypt(c.secret)}` }, signal: AbortSignal.timeout(15000) });
          if (!response.ok) return json(res, 502, { error: `Fornecedor não informou o saldo (HTTP ${response.status})` });
          const data = await response.json();
          return json(res, 200, { plan: typeof data.plan === 'string' ? data.plan : null, wallet: { balance: typeof data.wallet?.balance_usd === 'string' ? data.wallet.balance_usd : null, held: typeof data.wallet?.held_usd === 'string' ? data.wallet.held_usd : null, currency: 'USD' }, freeTokens: { remaining: Number.isSafeInteger(data.free_tokens?.remaining) ? data.free_tokens.remaining : null, limit: Number.isSafeInteger(data.free_tokens?.limit_per_day) ? data.free_tokens.limit_per_day : null }, checkedAt: new Date().toISOString() });
        } catch { return json(res, 502, { error: 'Não foi possível consultar o fornecedor' }); }
      }
      const toggleMatch = /^\/admin\/connections\/([\w-]+)\/toggle$/.exec(url.pathname);
      if (req.method === 'POST' && toggleMatch) {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req); if (typeof data.active !== 'boolean') return json(res, 400, { error: 'Estado inválido' });
        let found = false;
        await mutate(async () => { found = credentials.connections.some(c => c.id === toggleMatch[1]); if (found) { const next = { ...credentials, connections: credentials.connections.map(c => c.id === toggleMatch[1] ? { ...c, active: data.active } : c) }; await store.save('credentials', next); credentials = next; } });
        return found ? json(res, 200, { active: data.active }) : json(res, 404, { error: 'Credencial não encontrada' });
      }
      const modelMatch = /^\/admin\/connections\/([\w-]+)\/models$/.exec(url.pathname);
      if (req.method === 'POST' && modelMatch) {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req); const c = credentials.connections.find(item => item.id === modelMatch[1]);
        if (!c || typeof data.id !== 'string' || typeof data.enabled !== 'boolean' || !c.models?.some(m => m.id === data.id)) return json(res, 400, { error: 'Modelo ou credencial inválidos' });
        if (data.enabled && c.models.find(m => m.id === data.id).modality !== 'chat') return json(res, 400, { error: 'Somente modelos de chat podem ser habilitados por enquanto' });
        if (data.enabled) { const blocked = commercialGate(c.provider); if (blocked) return json(res, 403, { error: blocked }); }
        if (data.enabled && !['valid', 'endpoint_accepted'].includes(c.status)) return json(res, 400, { error: 'Configure um endpoint autenticado e valide esta credencial antes de habilitar modelos' });
        const existing = routes.find(r => r.id === data.id && r.connectionId === c.id && r.upstreamModel === data.id);
        const route = { id: data.id, provider: c.provider, connectionId: c.id, upstreamModel: data.id, enabled: data.enabled, destinationId: existing?.destinationId || randomUUID(), priority: existing?.priority ?? 100, ...normalizeRoutingFields(existing || {}) };
        const event = routeAuditEvent(routeChangeAction(existing, data.enabled), data.id, existing || null, route);
        await mutate(async () => { await saveRoutes([...routes.filter(r => !(r.id === data.id && r.connectionId === c.id && r.upstreamModel === data.id)), route]); await appendRouteAudit([event]); });
        return json(res, 200, { route });
      }
      if (req.method === 'GET' && url.pathname === '/admin/routes') return json(res, 200, { routes, policy: routingPolicy, audit: routeAudit });
      if (req.method === 'POST' && url.pathname === '/admin/routing-policy') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const next = normalizeRoutingPolicy(await body(req));
        const invalid = validateRoutingPolicy(next);
        if (invalid) return json(res, 400, { error: invalid });
        const event = routeAuditEvent('policy', 'routing', routingPolicy, next);
        await mutate(async () => { await store.save('routing-policy', next); routingPolicy = next; await appendRouteAudit([event]); });
        return json(res, 200, { policy: routingPolicy, audit: routeAudit });
      }
      if (req.method === 'POST' && url.pathname === '/admin/routes/rotate') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        if (typeof data.id !== 'string' || !data.id) return json(res, 400, { error: 'Modelo inválido' });
        const group = routes.filter(route => route.id === data.id).sort((a, b) => a.priority - b.priority || a.destinationId.localeCompare(b.destinationId));
        if (!group.length) return json(res, 404, { error: 'Modelo sem rotas' });
        const rotated = [...group.slice(1), group[0]].map((route, i) => ({ ...route, priority: group[0].priority + i }));
        const event = routeAuditEvent('rotate', data.id, group, rotated, 'rotação manual');
        await mutate(async () => {
          const byId = new Map(rotated.map(route => [route.destinationId, route]));
          await saveRoutes(routes.map(route => byId.get(route.destinationId) || route));
          await appendRouteAudit([event]);
        });
        return json(res, 200, { routes: rotated, audit: routeAudit });
      }
      const routeDeleteMatch = /^\/admin\/routes\/([\w-]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && routeDeleteMatch) {
        const destination = routes.find(route => route.destinationId === routeDeleteMatch[1]);
        if (!destination) return json(res, 404, { error: 'Destino não encontrado' });
        const event = routeAuditEvent('remove', destination.id, destination, null);
        await mutate(async () => { await saveRoutes(routes.filter(route => route.destinationId !== destination.destinationId)); await appendRouteAudit([event]); });
        return json(res, 200, { removed: destination.destinationId, audit: routeAudit });
      }
      // Sessão de cliente escolhida pelo admin: revogação em massa (logout) sem tocar na chave original.
      if (req.method === 'DELETE' && url.pathname === '/admin/keys/session') {
        clientSessions.clear();
        return json(res, 200, { revoked: true });
      }
      if (req.method === 'GET' && url.pathname === '/admin/keys') {
        const records = await usageStore.list();
        const usageByKey = new Map((await buildKeyUsage(clientKeys, records)).map(item => [item.keyId, item]));
        const billingByKey = new Map(buildKeyBilling(clientKeys, records, plans, pricingConfig.defaultMultiplier).map(item => [item.keyId, item]));
        const walletByKey = new Map(buildWallets(clientKeys, plans, topups, ledger).map(item => [item.keyId, item]));
        return json(res, 200, { keys: clientKeys.map(({ id, name, prefix, active, createdAt, planId, parentId }) => ({ id, name, prefix, active, createdAt, planId: planId || null, parentId: parentId || null, usage: usageByKey.get(id), billing: billingByKey.get(id), wallet: walletByKey.get(id) || null })) });
      }
      if (req.method === 'GET' && url.pathname === '/admin/users') {
        await ensureReferralCodes();
        return json(res, 200, buildAdminUsers({
          keys: clientKeys, plans, topups, entries: ledger, records: await usageStore.list(),
          referrals, codes: referralCodes, now: new Date().toISOString(),
        }));
      }
      if (req.method === 'POST' && ['/admin/provider', '/admin/keys', '/admin/keys/session', '/admin/keys/plan', '/admin/keys/revoke'].includes(url.pathname)) {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        if (url.pathname === '/admin/provider') {
          return json(res, 410, { error: 'Use o novo cadastro de conexões para validar a credencial.' });
        }
        if (url.pathname === '/admin/keys/session') {
          if (typeof data.keyId !== 'string') return json(res, 400, { error: 'Selecione uma chave cadastrada.' });
          const key = clientKeys.find(item => item.id === data.keyId && item.active);
          if (!key) return json(res, 404, { error: 'Chave não encontrada ou revogada.' });
          pruneClientSessions();
          revokeClientSessionsFor(key.id);
          const token = `anubis_sess_${randomBytes(24).toString('base64url')}`;
          const expiresAt = Date.now() + CLIENT_SESSION_TTL_MS;
          clientSessions.set(token, { keyId: key.id, expiresAt, createdAt: new Date().toISOString() });
          return json(res, 201, { token, keyId: key.id, label: key.name, prefix: key.prefix, expiresAt: new Date(expiresAt).toISOString() });
        }
        if (url.pathname === '/admin/keys') {
          if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80) return json(res, 400, { error: 'Informe um nome com até 80 caracteres' });
          if (data.planId && !plans.some(p => p.id === data.planId)) return json(res, 400, { error: 'Plano não encontrado' });
          const value = `anubis_${randomBytes(32).toString('base64url')}`;
          // Sem plano informado, a chave nova usa créditos pré-pagos; null explícito cria a chave sem plano.
          const planId = data.planId === undefined ? CREDIT_PLAN.id : data.planId || null;
          const item = { id: randomUUID(), name: data.name.trim(), prefix: value.slice(0, 15), hash: digest(value), active: true, createdAt: new Date().toISOString(), planId };
          await mutate(async () => {
            const next = [...clientKeys, item]; await store.save('api-keys', next); clientKeys = next;
            referralCodes[item.id] = makeReferralCode(); await store.save('referral-codes', referralCodes);
          });
          return json(res, 201, { key: value, id: item.id });
        }
        if (typeof data.id !== 'string') return json(res, 400, { error: 'ID inválido' });
        if (url.pathname === '/admin/keys/plan') {
          if (data.planId && !plans.some(p => p.id === data.planId)) return json(res, 404, { error: 'Plano não encontrado' });
          let found = false;
          await mutate(async () => { found = clientKeys.some(k => k.id === data.id); if (found) { const next = clientKeys.map(k => k.id === data.id ? { ...k, planId: data.planId || null } : k); await store.save('api-keys', next); clientKeys = next; } });
          return found ? json(res, 200, { planId: data.planId || null }) : json(res, 404, { error: 'Chave não encontrada' });
        }
        let found = false;
        await mutate(async () => { found = clientKeys.some(k => k.id === data.id); if (found) { const next = clientKeys.map(k => k.id === data.id ? { ...k, active: false } : k); await store.save('api-keys', next); clientKeys = next; } });
        return found ? json(res, 200, { revoked: true }) : json(res, 404, { error: 'Chave não encontrada' });
      }
      const userAction = /^\/admin\/users\/([^/]+)\/(plan|active|keys)$/.exec(url.pathname);
      if (req.method === 'POST' && userAction) {
        let rootId = '';
        try { rootId = decodeURIComponent(userAction[1]); } catch { return json(res, 400, { error: 'ID de usuário inválido.' }); }
        const familyInfo = findUserFamily(clientKeys, rootId);
        if (!familyInfo) return json(res, 404, { error: 'Usuário não encontrado.' });
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        const familyIds = new Set(familyInfo.family.map(key => key.id));
        if (userAction[2] === 'plan') {
          const invalid = validateUserPlan(data, plans, familyInfo.family);
          if (invalid) return json(res, 400, { error: invalid });
          const planId = data.planId || null;
          await mutate(async () => {
            const next = clientKeys.map(key => familyIds.has(key.id) ? { ...key, planId } : key);
            await store.save('api-keys', next); clientKeys = next;
          });
          return json(res, 200, { updated: familyIds.size, planId });
        }
        if (userAction[2] === 'active') {
          const invalid = validateUserActive(data);
          if (invalid) return json(res, 400, { error: invalid });
          const active = data.active === true;
          await mutate(async () => {
            const next = clientKeys.map(key => familyIds.has(key.id) ? { ...key, active } : key);
            await store.save('api-keys', next); clientKeys = next;
          });
          if (!active) for (const key of familyInfo.family) revokeClientSessionsFor(key.id);
          return json(res, 200, { updated: familyIds.size, active, blocked: !active });
        }
        const invalid = validateUserKeyCreate(data, familyInfo.family, plans);
        if (invalid) return json(res, 400, { error: invalid });
        const value = `anubis_${randomBytes(32).toString('base64url')}`;
        const item = {
          id: randomUUID(), name: data.name.trim(), prefix: value.slice(0, 15), hash: digest(value),
          active: true, createdAt: new Date().toISOString(), planId: data.planId || null, parentId: familyInfo.root.id,
        };
        await mutate(async () => {
          const next = [...clientKeys, item];
          await store.save('api-keys', next); clientKeys = next;
        });
        return json(res, 201, { key: value, id: item.id, rootId: familyInfo.root.id, label: item.name });
      }
      if (req.method === 'POST' && url.pathname === '/admin/routes') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const route = await body(req);
        if (!validRoute(route)) return json(res, 400, { error: 'Dados da rota inválidos' });
        const connection = credentials.connections.find(c => c.id === route.connectionId && c.provider === route.provider);
        if (!connection) return json(res, 400, { error: 'Selecione uma credencial válida para esta rota' });
        if (route.enabled && !['valid', 'endpoint_accepted'].includes(connection.status)) return json(res, 400, { error: 'Valide a credencial antes de habilitar esta rota' });
        const priority = route.priority ?? 100;
        if (!Number.isSafeInteger(priority) || priority < 1 || priority > 9999) return json(res, 400, { error: 'Prioridade deve estar entre 1 e 9999.' });
        const existing = route.destinationId ? routes.find(r => r.destinationId === route.destinationId && r.id === route.id) : null;
        if (route.destinationId && !existing) return json(res, 404, { error: 'Destino não encontrado para este modelo.' });
        const fields = normalizeRoutingFields({ weight: route.weight ?? existing?.weight, cooldownUntil: route.cooldownUntil ?? existing?.cooldownUntil });
        const fieldError = validateRoutingFields(fields);
        if (fieldError) return json(res, 400, { error: fieldError });
        const clean = { id: route.id, provider: route.provider, connectionId: connection.id, upstreamModel: route.upstreamModel, enabled: route.enabled, destinationId: route.destinationId || randomUUID(), priority, ...fields };
        const auditEvent = routeAuditEvent(routeChangeAction(existing, clean.enabled), clean.id, existing || null, clean);
        let duplicate = false;
        await mutate(async () => { duplicate = routes.some(r => r.destinationId !== clean.destinationId && r.id === clean.id && r.connectionId === clean.connectionId && r.upstreamModel === clean.upstreamModel); if (!duplicate) { await saveRoutes([...routes.filter(r => r.destinationId !== clean.destinationId), clean]); await appendRouteAudit([auditEvent]); } });
        if (duplicate) return json(res, 409, { error: 'Este destino já está cadastrado para o modelo.' });
        return json(res, 200, { route: clean });
      }
      return json(res, 404, { error: 'Rota não encontrada' });
    }
    // Confirmação de pagamento assinada por um gateway ou automação: aprova o pedido de recarga correspondente.
    if (req.method === 'POST' && url.pathname === '/payments/confirm') {
      const secret = process.env.ANUBIS_PAYMENT_WEBHOOK_SECRET || '';
      if (secret.length < 32) return json(res, 404, { error: 'Rota não encontrada' });
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) return json(res, 413, { error: 'Corpo muito grande.' }); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8');
      const invalid = verifyPaymentSignature({ secret, timestamp: req.headers['x-anubis-timestamp'], signature: req.headers['x-anubis-signature'], raw });
      if (invalid) return json(res, 401, { error: invalid });
      let data; try { data = JSON.parse(raw); } catch { return json(res, 400, { error: 'JSON inválido.' }); }
      const request = typeof data?.requestId === 'string' ? topupRequests.find(item => item.id === data.requestId) : null;
      const mismatch = validatePaymentConfirmation(data, request);
      if (mismatch) return json(res, request || !data?.requestId ? 400 : 404, { error: mismatch });
      // Reenvio do mesmo pagamento é aceito sem creditar de novo; outra referência para pedido já pago é conflito.
      if (request.status === 'approved') {
        const same = request.payment?.reference === data.reference;
        return json(res, same ? 200 : 409, same ? { request: clientTopupRequest(request), duplicate: true } : { error: 'Pedido já creditado por outro pagamento.' });
      }
      if (topupRequests.some(item => item.payment?.reference === data.reference)) return json(res, 409, { error: 'Referência de pagamento já usada em outro pedido.' });
      const payment = { reference: data.reference, provider: typeof data.provider === 'string' ? data.provider.slice(0, 40) : null, confirmedAt: new Date().toISOString() };
      const outcome = await decideTopupRequest(request.id, 'approve', `Pagamento confirmado automaticamente (${payment.reference})`, payment);
      if (outcome.failure) return json(res, outcome.failure[0], { error: outcome.failure[1] });
      return json(res, 200, { request: clientTopupRequest(outcome.request), duplicate: false });
    }
    // Notificação de pagamento de qualquer gateway ligado (/payments/<gateway>/notify): credita o pedido quando o
    // pagamento foi concluído e bate com ele em valor e moeda. Reenvios do mesmo pagamento não creditam de novo.
    const notifyMatch = /^\/payments\/([a-z0-9-]{2,40})\/notify$/.exec(url.pathname);
    if (req.method === 'POST' && notifyMatch) {
      const gateway = findGateway(notifyMatch[1]);
      if (!gateway) return json(res, 404, { error: 'Rota não encontrada' });
      const { adapter, config } = gateway;
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) return json(res, 413, { error: 'Corpo muito grande.' }); chunks.push(chunk); }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let data;
      try { data = parseNotification(rawBody, req.headers['content-type'] || ''); }
      catch { return json(res, 400, { error: 'Corpo inválido.' }); }
      const orderId = adapter.orderId(data);
      const request = orderId ? topupRequests.find(item => item.id === orderId) : null;
      const verdict = adapter.evaluate(config, data, request, { raw: rawBody, headers: req.headers });
      if (verdict.error) return json(res, 400, { error: verdict.error });
      if (!verdict.approve) {
        console.log(`${adapter.label}: pedido ${orderId || '?'} não creditado (${verdict.reason}), transação ${verdict.reference || '?'}`);
        return json(res, 200, { ok: true, credited: false, reason: verdict.reason });
      }
      if (request.status === 'approved') return json(res, 200, { ok: true, credited: false, reason: 'ja_creditado' });
      const payment = { provider: adapter.id, reference: verdict.reference, method: verdict.method || null, confirmedAt: new Date().toISOString() };
      const outcome = await decideTopupRequest(request.id, 'approve', `Pago via ${adapter.label} (${verdict.reference})`, payment);
      if (outcome.failure && outcome.failure[0] !== 409) return json(res, outcome.failure[0], { error: outcome.failure[1] });
      return json(res, 200, { ok: true, credited: !outcome.failure });
    }
    // Playground público: lista dos modelos grátis e quantas mensagens restam para este visitante.
    if (req.method === 'GET' && url.pathname === '/public/playground') {
      const enabled = new Set(enabledModelIds());
      return json(res, 200, { models: PLAYGROUND_MODELS.filter(id => enabled.has(id)), freeMessages: PLAYGROUND_FREE_MESSAGES, remaining: Math.max(0, PLAYGROUND_FREE_MESSAGES - playgroundByIp.count(tokenHash(clientIp(req)))) });
    }
    // Mensagem anônima: segue pelo mesmo gateway do /v1, com a chave virtual do Playground (sem custo, sem saldo).
    if (req.method === 'POST' && url.pathname === '/public/playground/chat/completions') {
      req.anubisPlayground = true;
      url.pathname = '/v1/chat/completions';
    }
    if (url.pathname.startsWith('/account/')) {
      const ip = tokenHash(clientIp(req));
      const generic = { ok: true, message: 'Se existir uma conta com esses dados, enviamos um e-mail. Confira também a caixa de spam.' };
      if (req.method === 'GET' && url.pathname === '/account/me') {
        const found = accountSession(presentedKey(req) || '');
        if (!found) return json(res, 401, { error: { message: 'Sessão encerrada. Entre novamente.', type: 'authentication_error' } });
        return json(res, 200, { account: publicAccount(found.account, clientKeys.find(k => k.id === found.account.keyId) || null) });
      }
      if (req.method === 'POST' && url.pathname === '/account/logout') {
        const hash = tokenHash(presentedKey(req) || '');
        if (accountSessions.some(s => s.hash === hash)) await mutate(async () => { const next = accountSessions.filter(s => s.hash !== hash); await store.save('account-sessions', next); accountSessions = next; });
        return json(res, 200, { ok: true });
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'Rota não encontrada' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
      let data;
      try { data = await body(req); } catch { return json(res, 400, { error: 'Corpo inválido.' }); }
      if (url.pathname === '/account/signup') {
        if (!authLimits.signup.take(ip)) return json(res, 429, { error: 'Muitos cadastros a partir desta rede. Tente de novo em uma hora.' });
        const checked = validateSignup(accounts, data);
        if (checked.error) return json(res, checked.field ? 409 : 400, { error: checked.error, field: checked.field || null });
        // Chave atual opcional: precisa ser uma chave raiz ativa ainda não vinculada a outra conta.
        let keyId = null;
        if (typeof data.existingKey === 'string' && data.existingKey.trim()) {
          const value = data.existingKey.trim();
          const key = clientKeys.find(k => k.active && equal(k.hash, digest(value)));
          if (!key) return json(res, 400, { error: 'Chave atual inválida ou revogada.', field: 'existingKey' });
          if (key.parentId) return json(res, 400, { error: 'Informe a chave principal da conta, não uma chave criada a partir dela.', field: 'existingKey' });
          if (accounts.some(a => a.keyId === key.id)) return json(res, 409, { error: 'Esta chave já pertence a outra conta.', field: 'existingKey' });
          keyId = key.id;
        }
        const account = { id: randomUUID(), username: checked.username, email: checked.email, passwordHash: hashPassword(checked.password), emailVerifiedAt: null, createdAt: new Date().toISOString(), keyId };
        await mutate(async () => { const next = [...accounts, account]; await store.save('accounts', next); accounts = next; });
        authLimits.email.take(account.email);
        const sent = await sendAccountEmail(account, 'verify');
        return json(res, 201, { ok: true, emailSent: sent, linkedKey: !!keyId, message: `Enviamos um link de confirmação para ${account.email}.` });
      }
      if (url.pathname === '/account/verify' || url.pathname === '/account/magic-login') {
        const type = url.pathname === '/account/verify' ? 'verify' : 'magic';
        const used = consumeEmailToken(accountTokens, data.token, type);
        if (used.tokens) await mutate(async () => { await store.save('account-tokens', used.tokens); accountTokens = used.tokens; });
        if (used.error) return json(res, 400, { error: used.error });
        let account = accounts.find(a => a.id === used.accountId && !a.disabled);
        if (!account) return json(res, 400, { error: 'Conta não encontrada.' });
        // Abrir o link mágico também comprova o e-mail.
        if (!account.emailVerifiedAt) await mutate(async () => { const next = accounts.map(a => a.id === account.id ? { ...a, emailVerifiedAt: new Date().toISOString() } : a); await store.save('accounts', next); accounts = next; });
        account = await ensureAccountKey(accounts.find(a => a.id === account.id));
        const session = await openAccountSession(account);
        return json(res, 200, { ...session, account: publicAccount(account, clientKeys.find(k => k.id === account.keyId) || null) });
      }
      if (url.pathname === '/account/login') {
        if (!authLimits.login.take(ip)) return json(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos ou peça um link de acesso por e-mail.' });
        const account = findAccountByLogin(accounts, data.login);
        // Sem conta, a senha é verificada contra um hash fixo para o tempo de resposta não revelar quem existe.
        const valid = verifyPassword(typeof data.password === 'string' ? data.password : '', account?.passwordHash || DUMMY_PASSWORD_HASH) && !!account && !account.disabled;
        if (!valid) return json(res, 401, { error: 'Usuário, e-mail ou senha incorretos.' });
        if (!account.emailVerifiedAt) return json(res, 403, { error: 'Confirme seu e-mail antes de entrar. Podemos reenviar o link.', type: 'email_not_verified' });
        const ready = await ensureAccountKey(account);
        const session = await openAccountSession(ready);
        return json(res, 200, { ...session, account: publicAccount(ready, clientKeys.find(k => k.id === ready.keyId) || null) });
      }
      if (url.pathname === '/account/magic-link' || url.pathname === '/account/resend') {
        const account = findAccountByLogin(accounts, data.login);
        if (!authLimits.login.take(ip)) return json(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos.' });
        const type = url.pathname === '/account/resend' ? 'verify' : 'magic';
        if (account && !account.disabled && (type === 'magic' || !account.emailVerifiedAt) && authLimits.email.take(account.email)) await sendAccountEmail(account, type);
        return json(res, 200, generic);
      }
      return json(res, 404, { error: 'Rota não encontrada' });
    }
    // Revogação da sessão escolhida no painel, feita pelo próprio portador do token (sem chave administrativa).
    if (req.method === 'DELETE' && url.pathname === '/client-session') {
      const token = presentedKey(req);
      return json(res, 200, { revoked: !!token && clientSessions.delete(token) });
    }
    // Área do cliente: autenticada pela própria chave, sem login administrativo e sem modelo de contas.
    if (url.pathname === '/me' || url.pathname.startsWith('/me/')) {
      const key = clientForRequest(req);
      if (!key) return json(res, 401, { error: { message: 'Chave Anubis inválida', type: 'authentication_error' } });
      const root = rootKeyId(key);
      const family = () => ownerKeys(clientKeys, key);
      const now = new Date().toISOString();
      const listKeys = () => buildSelfServiceSummary({ key, keys: clientKeys, plans, records: [], entries: [], topups: [], now }).keys;
      if (req.method === 'GET' && ['/me', '/me/summary', '/me/keys'].includes(url.pathname)) {
        if (url.pathname === '/me/keys') return json(res, 200, { keys: listKeys(), maxKeys: MAX_KEYS_PER_OWNER });
        const report = buildSelfServiceSummary({ key, keys: clientKeys, plans, records: await usageStore.list(), entries: ledger, topups, now });
        return json(res, 200, report);
      }
      // Créditos da conta: saldo, pedidos de recarga e extrato de gastos. O saldo é do titular (chave principal).
      if (req.method === 'GET' && url.pathname === '/me/credits') {
        const familyKeys = family();
        const wallet = buildWallets(familyKeys, plans, topups, ledger).find(item => item.keyId === root) || null;
        const statement = clientStatement(ledger, familyKeys, 50);
        return json(res, 200, {
          wallet: wallet ? { currency: wallet.currency, balance: wallet.balance, credits: wallet.credits, consumed: wallet.consumed, requests: wallet.requests, negative: wallet.negative } : null,
          presets: TOPUP_PRESETS, min: MIN_TOPUP, max: MAX_TOPUP, currency: 'USD',
          checkout: (() => { const gateways = publicGateways(); return { enabled: gateways.length > 0, provider: gateways[0]?.id || null, gateways }; })(),
          requests: topupRequests.filter(item => item.keyId === root).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map(clientTopupRequest),
          statement, byModel: spendByModel(clientStatement(ledger, familyKeys, 200)),
        });
      }
      if (req.method === 'POST' && url.pathname === '/me/topup-requests') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        const pending = topupRequests.filter(item => item.keyId === root && item.status === 'pending').length;
        const checked = validateTopupRequest(data, pending);
        if (checked.error) return json(res, 400, { error: checked.error });
        const item = { id: randomUUID(), keyId: root, requestedBy: key.id, amount: checked.amount, currency: checked.currency, status: 'pending', createdAt: now, decidedAt: null, reason: null, topupId: null };
        await mutate(async () => { await entries.upsert('topup-requests', item); topupRequests = [...topupRequests, item]; });
        return json(res, 201, { request: clientTopupRequest(item) });
      }
      // Pagamento online do pedido no gateway escolhido (o primeiro ligado, se o cliente não escolher).
      const checkoutMatch = /^\/me\/topup-requests\/([\w-]{1,80})\/checkout$/.exec(url.pathname);
      if (req.method === 'POST' && checkoutMatch) {
        let data = {};
        try { data = await body(req); } catch { data = {}; }
        const wanted = typeof data?.gateway === 'string' ? data.gateway : publicGateways()[0]?.id;
        const gateway = wanted ? findGateway(wanted) : null;
        if (!gateway) return json(res, 404, { error: 'Pagamento online ainda não está disponível. Aguarde as instruções da equipe.' });
        const request = topupRequests.find(item => item.id === checkoutMatch[1] && item.keyId === root);
        if (!request) return json(res, 404, { error: 'Pedido não encontrado.' });
        if (request.status !== 'pending') return json(res, 409, { error: 'Este pedido já foi decidido.' });
        const site = (process.env.ANUBIS_SITE_URL || 'https://anubisrouter.com').replace(/\/+$/, '');
        try { return json(res, 200, { gateway: gateway.adapter.id, ...(await gateway.adapter.checkout(gateway.config, request, { returnUrl: `${site}/minha-conta?pagamento=retorno` })) }); }
        catch (error) { console.error(`${gateway.adapter.label}: checkout falhou`, error.message); return json(res, 502, { error: 'Não foi possível abrir o pagamento agora. Tente de novo ou use outro meio.' }); }
      }
      if (req.method === 'GET' && url.pathname === '/me/stats') {
        const period = periodFrom(url);
        if (period.error) return json(res, 400, { error: period.error });
        const report = buildClientStats({ key, records: await usageStore.list(), entries: ledger, period, now });
        if (report?.error) return json(res, 400, { error: report.error });
        return json(res, 200, report);
      }
      if (req.method === 'GET' && url.pathname === '/me/referrals') {
        await ensureReferralCodes();
        return json(res, 200, buildClientReferralReport({ key, records: referrals.filter(item => item.ownerKeyId === root), now, baseUrl: referralBaseUrl(req), codes: referralCodes }));
      }
      if (req.method === 'POST' && ['/me/keys', '/me/keys/plan', '/me/keys/revoke'].includes(url.pathname)) {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Use application/json' });
        const data = await body(req);
        if (url.pathname === '/me/keys') {
          const invalid = validateCreateKey(data, family(), plans, key);
          if (invalid) return json(res, 400, { error: invalid });
          const value = `anubis_${randomBytes(32).toString('base64url')}`;
          const planId = data.planId || key.planId || null;
          const item = { id: randomUUID(), name: String(data.name).trim().slice(0, 80), prefix: value.slice(0, 15), hash: digest(value), active: true, createdAt: now, planId, parentId: root };
          await mutate(async () => {
            const next = [...clientKeys, item]; await store.save('api-keys', next); clientKeys = next;
            appendSelfServiceAudit({ id: randomUUID(), at: now, actorKeyId: key.id, action: 'create_key', targetKeyId: item.id, before: null, after: { parentId: root, planId }, reason: null });
            await store.save('client-self-service-audit', selfServiceAudit);
          });
          return json(res, 201, { key: value, id: item.id });
        }
        const invalid = url.pathname === '/me/keys/plan' ? validatePlanChange(data, family(), plans) : validateRevoke(data, family());
        if (invalid) return json(res, 400, { error: invalid });
        const target = family().find(item => item.id === data.id);
        if (!target) return json(res, 404, { error: 'Chave não encontrada' });
        const action = url.pathname === '/me/keys/plan' ? 'change_plan' : 'revoke_key';
        const before = action === 'change_plan' ? { planId: target.planId || null } : { active: true };
        const after = action === 'change_plan' ? { planId: data.planId } : { active: false };
        await mutate(async () => {
          clientKeys = clientKeys.map(item => item.id === target.id ? { ...item, ...after } : item);
          await store.save('api-keys', clientKeys);
          appendSelfServiceAudit({ id: randomUUID(), at: now, actorKeyId: key.id, action, targetKeyId: target.id, before, after, reason: null });
          await store.save('client-self-service-audit', selfServiceAudit);
        });
        return json(res, 200, after);
      }
      return json(res, 404, { error: 'Rota não encontrada' });
    }
    // Catálogo público do painel do cliente: preço de venda e disponibilidade, sem custo, conexão ou credencial.
    if (req.method === 'GET' && url.pathname === '/public/models') {
      const now = Date.now();
      if (!publicCatalogCache || now - publicCatalogCache.at > 60_000) {
        const records = await usageStore.list();
        const data = buildPublicCatalog({ routes, connectionForRoute, records, now, originals: originalPrices, resolve: (provider, model) => resolvePrices(priceHistory, new Date(now).toISOString(), provider, model, null) });
        publicCatalogCache = { at: now, data };
      }
      return json(res, 200, { object: 'list', updatedAt: new Date(publicCatalogCache.at).toISOString(), data: publicCatalogCache.data });
    }
    if (url.pathname.startsWith('/v1/')) {
      const clientKey = req.anubisPlayground ? PLAYGROUND_KEY : clientForRequest(req);
      if (!clientKey) return json(res, 401, { error: { message: 'Chave Anubis inválida', type: 'authentication_error' } });
      const clientPlan = plans.find(p => p.id === clientKey.planId) || null;
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const visible = clientPlan?.active === false ? [] : enabledModelIds().filter(id => planAllowsModel(clientPlan, id));
        return json(res, 200, { object: 'list', data: visible.map(id => ({ id, object: 'model', owned_by: 'anubis' })) });
      }
      if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/messages', '/v1/responses'].includes(url.pathname)) return json(res, 404, { error: { message: 'Endpoint não implementado' } });
      const input = await body(req, bytes => traffic.noteRequestBytes(bytes));
      if (req.anubisPlayground) {
        if (!PLAYGROUND_MODELS.includes(input?.model)) return json(res, 403, { error: { message: 'No Playground sem conta, use um dos modelos grátis.', type: 'permission_error' } });
        if (!Array.isArray(input.messages) || JSON.stringify(input.messages).length > 24_000) return json(res, 413, { error: { message: 'Conversa longa demais para o Playground sem conta. Entre para continuar.', type: 'login_required' } });
        const visitor = tokenHash(clientIp(req));
        if (!playgroundByIp.take(visitor)) return json(res, 401, { error: { message: 'Você usou as mensagens grátis. Entre ou crie uma conta para continuar.', type: 'login_required' }, remaining: 0 });
        if (!playgroundAll.take('all')) return json(res, 503, { error: { message: 'O Playground grátis atingiu o limite de hoje. Entre para continuar.', type: 'login_required' } });
        // Falha do gateway ou do fornecedor (5xx) não gasta a mensagem grátis.
        res.on('finish', () => { if (res.statusCode >= 500) { playgroundByIp.refund(visitor); playgroundAll.refund('all'); } });
        res.setHeader('x-playground-remaining', String(Math.max(0, PLAYGROUND_FREE_MESSAGES - playgroundByIp.count(visitor))));
        res.setHeader('access-control-expose-headers', 'x-request-id, x-playground-remaining');
        input.max_tokens = Math.min(Number.isSafeInteger(input.max_tokens) && input.max_tokens > 0 ? input.max_tokens : 1024, 1024);
        delete input.tools; delete input.tool_choice;
      }
      if (clientPlan && !planAllowsModel(clientPlan, input.model)) return json(res, 403, { error: { message: 'Modelo não permitido neste plano', type: 'permission_error' } });
      // Cotas contam só os registros desta chave no mês corrente, direto do banco (sem o teto global de 10 mil).
      const month = monthWindow();
      const records = await usageStore.listForKeys([clientKey.id], month.start);
      const quota = checkPlanQuota(clientPlan, usageInWindow(records, clientKey.id, month));
      // A franquia diária conta tokens estimados e chamadas canceladas: o fornecedor já consumiu a cota.
      const dailyQuota = checkDailyQuota(clientPlan, usageInWindow(records, clientKey.id, dayWindow(), ['completed', 'cancelled']));
      for (const check of [quota, dailyQuota]) if (!check.allowed) {
        const messages = { requests: 'Limite de requisições do plano atingido', tokens: 'Limite de tokens do plano atingido', daily_requests: 'Limite diário de requisições atingido', daily_tokens: 'Limite diário de tokens atingido', inactive: 'Plano inativo' };
        return json(res, 429, { error: { message: messages[check.reason] || 'Limite do plano atingido', type: check.reason === 'inactive' ? 'permission_error' : 'rate_limit_error', reason: check.reason, used: check.used, limit: check.limit, resetAt: check.resetAt } });
      }
      const requestId = randomUUID();
      // Estimativa local de entrada: usada apenas quando o fornecedor omite o uso.
      const inputTokens = estimateInputTokens(input);
      // Falha capturada é metadado controlado: nunca inclui erro bruto, prompt, resposta ou segredo.
      const failureMeta = (stage, reason, status = null, retryable = false) => ({ stage, reason, status, retryable });
      const configured = routes.filter(r => r.enabled && r.id === input.model && connectionForRoute(r));
      if (!configured.length) return json(res, 404, { error: { message: 'Modelo não configurado ou desabilitado' } });
      const balanceKey = `${clientKey.id}\u0000${url.pathname}\u0000${input.model}`;
      const cursor = balanceCursors.get(balanceKey) || 0;
      // Rodízio usa contador por chave/endpoint/modelo; peso continua usando o request ID.
      const balanceSeed = routingPolicy.strategy === 'round_robin' ? cursor : requestId;
      const available = orderedCandidates(configured.filter(r => !isCoolingDown(r)), routingPolicy, balanceSeed);
      if (!available.length) return json(res, 503, { error: { message: 'Nenhum destino está disponível' } });
      balanceCursors.set(balanceKey, nextCursor(routingPolicy, cursor));
      const compatible = available.filter(r => !connector(connectionForRoute(r).provider)?.chatOnly || url.pathname === '/v1/chat/completions');
      if (!compatible.length) return json(res, 400, { error: { message: 'Nenhum destino suporta este endpoint' } });
      // Saldo simulado é verificado antes da chamada; não há reserva, então chamadas concorrentes podem exceder o limite.
      const paygWallet = clientPlan?.kind === 'payg' ? buildWallets(ownerKeys(clientKeys, clientKey), plans, topups, ledger).find(item => item.keyId === rootKeyId(clientKey)) || null : null;
      let insufficient = null; let attempted = false;
      const controller = new AbortController();
      let cancelled = false;
      res.on('close', () => { if (!res.writableEnded) { cancelled = true; controller.abort(); } });
      for (let i = 0; i < compatible.length; i++) {
        const route = compatible[i]; const connection = connectionForRoute(route);
        if (!connection) continue;
        const headers = { authorization: `Bearer ${decrypt(connection.secret)}`, 'content-type': 'application/json', accept: req.headers.accept || 'application/json' };
        for (const h of ['anthropic-version', 'anthropic-beta']) if (req.headers[h]) headers[h] = req.headers[h];
        const providerModel = connection.models?.find(m => m.id === route.upstreamModel);
        const costSnapshot = priceSnapshot(providerModel, connection.provider);
        const startedAt = new Date().toISOString();
        // Preço fixado antes da chamada: alterações posteriores não mudam este lançamento.
        const saleSnapshot = saleSnapshotFor(startedAt, connection.provider, route.upstreamModel, clientPlan, route.id);
        if (paygWallet) {
          const check = checkWalletBalance(paygWallet, quoteSale(costSnapshot, saleSnapshot, {}));
          if (!check.allowed) {
            const messages = {
              no_wallet: 'Chave sem carteira PAYG',
              currency_pending: 'Moeda da venda difere da carteira, sem conversão automática',
              unpriced: 'Preço de venda indisponível para esta chamada',
              insufficient_balance: 'Saldo insuficiente',
            };
            insufficient = { message: messages[check.reason] || 'Saldo insuficiente', type: check.reason, balance: check.balance, required: check.required, currency: check.currency };
            continue;
          }
        }
        const record = { id: randomUUID(), requestId, attempt: i + 1, destinationId: route.destinationId, startedAt, status: 'pending', provider: connection.provider, connectionId: connection.id, clientKeyId: clientKey.id, planId: clientKey.planId || null, publicModel: route.id, upstreamModel: route.upstreamModel, endpoint: url.pathname, costSnapshot, saleSnapshot, usage: {}, failure: null };
        const counters = { outputChars: 0 };
        await usageStore.write(record);
        attempted = true;
        const timeoutController = new AbortController();
        const defaultTimeout = process.env.NODE_ENV === 'test' && process.env.TEST_UPSTREAM_TIMEOUT_MS ? Number(process.env.TEST_UPSTREAM_TIMEOUT_MS) : 30000;
        const timer = setTimeout(() => timeoutController.abort(), resolveTimeout(routingPolicy, defaultTimeout));
        const canRetry = i + 1 < compatible.length && (routingPolicy.maxAttempts === null || i + 1 < routingPolicy.maxAttempts);
        try {
          const upstreamBody = JSON.stringify({ ...input, model: route.upstreamModel });
          traffic.noteUpstreamRequestBytes(Buffer.byteLength(upstreamBody));
          const response = await providerFetch(originFor(connection) + url.pathname + url.search, { method: 'POST', headers, body: upstreamBody, signal: AbortSignal.any([controller.signal, timeoutController.signal]), redirect: 'error' });
          clearTimeout(timer);
          record.httpStatus = response.status;
          const retry = shouldRetry(routingPolicy, response.status, i + 1, compatible.length);
          if (retry) {
            record.status = 'upstream_error';
            record.failure = failureMeta('http', 'resposta_http', response.status, true);
            balanceCursors.set(balanceKey, nextCursor(routingPolicy, cursor, i + 1));
            await response.body?.cancel();
            await coolDownRoute(route, `HTTP ${response.status}`);
            continue;
          }
          if (!response.ok) record.failure = failureMeta('http', 'resposta_http', response.status, false);
          const outgoing = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-anubis-model': route.upstreamModel, 'x-anubis-fallback': i ? 'true' : 'false', 'x-request-id': requestId };
          for (const h of ['content-type', 'retry-after']) if (response.headers.has(h)) outgoing[h] = response.headers.get(h);
          if (response.headers.has('x-request-id')) outgoing['x-upstream-request-id'] = response.headers.get('x-request-id');
          res.writeHead(response.status, outgoing);
          if (response.body) await pipeline(Readable.fromWeb(response.body), usageObserver(response.headers.get('content-type') || '', record.usage, bytes => traffic.noteStreamedResponseBytes(bytes), counters), res); else res.end();
          record.status = response.ok ? 'completed' : 'upstream_error';
          return;
        } catch (error) {
          const timeout = timeoutController.signal.aborted && !controller.signal.aborted;
          record.status = cancelled || controller.signal.aborted ? 'cancelled' : 'upstream_unknown';
          record.failure = cancelled ? failureMeta('cliente', 'cancelado') : failureMeta(timeout ? 'timeout' : 'transporte', timeout ? 'tempo_esgotado' : 'falha_transporte', null, canRetry);
          if (!cancelled && !res.headersSent && canRetry) {
            balanceCursors.set(balanceKey, nextCursor(routingPolicy, cursor, i + 1));
            await coolDownRoute(route, timeout ? 'tempo esgotado' : 'falha de transporte');
            continue;
          }
          throw error;
        } finally {
          clearTimeout(timer);
          finalizeUsage(record.usage, { inputTokens, outputChars: counters.outputChars });
          record.finishedAt = new Date().toISOString();
          try { await usageStore.write(record); } catch { console.error('Falha ao registrar conclusão de uso; reconciliação necessária.'); }
          void pruneUsageIfDue();
          if (record.status === 'completed') {
            try { await recordLedgerCompletion(record); } catch { console.error('Falha ao lançar no ledger; reconciliação necessária.'); }
          }
        }
      }
      if (!res.headersSent && !cancelled && !attempted && insufficient) return json(res, 402, { error: insufficient });
      if (!res.headersSent && !cancelled) return json(res, 503, { error: { message: 'Nenhum destino está disponível' } });
      return;
    }
    return json(res, 404, { error: 'Não encontrado' });
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e instanceof SyntaxError || e.message === 'Corpo excede 8 MB') return json(res, 400, { error: { message: e.message } });
    console.error('Falha na requisição:', e.name);
    return json(res, 502, { error: { message: 'Falha ao processar a requisição' } });
  }
});
server.listen(port, host, () => console.log(`Anubis Router: http://${host}:${port} (dados: ${store.kind})`));

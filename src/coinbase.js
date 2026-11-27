// Coinbase Business: checkout hospedado (pagamento em USDC) e webhook assinado. Substitui o Coinbase Commerce (legado).
// Documentação: docs.cdp.coinbase.com/coinbase-business (Checkouts API, webhooks, autenticação por JWT).
//
// Variáveis: COINBASE_API_KEY_NAME (organizations/{org}/apiKeys/{id}), COINBASE_API_KEY_SECRET (Ed25519, base64 de 64 bytes:
// semente de 32 + chave pública de 32) e COINBASE_WEBHOOK_SECRET (devolvido ao criar a assinatura do webhook).
// A chave precisa só da permissão "View" (criar checkouts); Trade e Transfer não são necessárias.
import { createHmac, createPrivateKey, randomBytes, sign, timingSafeEqual } from 'node:crypto';

const HOST = 'business.coinbase.com';
const CHECKOUTS_PATH = '/api/v1/checkouts';
const MAX_AGE_SECONDS = 5 * 60;
// Prefixo PKCS#8 de uma chave privada Ed25519 (RFC 8410); a semente de 32 bytes vem em seguida.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const b64url = value => Buffer.from(value).toString('base64url');

export function coinbaseConfig(env = process.env) {
  const keyName = (env.COINBASE_API_KEY_NAME || '').trim();
  const keySecret = (env.COINBASE_API_KEY_SECRET || '').trim();
  const webhookSecret = (env.COINBASE_WEBHOOK_SECRET || '').trim();
  if (!keyName || !keySecret || !webhookSecret) return null;
  return { keyName, keySecret, webhookSecret };
}

/** JWT EdDSA de 2 minutos para uma chamada (METHOD host+path), como nos exemplos oficiais da CDP. */
export function coinbaseJwt({ keyName, keySecret }, method, path, now = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.from(keySecret, 'base64');
  if (raw.length !== 64 && raw.length !== 32) throw new Error('COINBASE_API_KEY_SECRET deve ser a chave Ed25519 em base64');
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  const header = { alg: 'EdDSA', typ: 'JWT', kid: keyName, nonce: randomBytes(16).toString('hex') };
  const claims = { sub: keyName, iss: 'cdp', aud: ['cdp_service'], nbf: now, exp: now + 120, uri: `${method} ${HOST}${path}` };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}

const twoDecimals = amount => Number(amount).toFixed(2);

/** Cria o checkout hospedado e devolve { redirect } para o navegador do cliente. */
export async function coinbaseCheckout(config, request, { returnUrl, fetcher = fetch } = {}) {
  const response = await fetcher(`https://${HOST}${CHECKOUTS_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${coinbaseJwt(config, 'POST', CHECKOUTS_PATH)}`,
      'content-type': 'application/json',
      // O mesmo pedido de recarga nunca abre dois checkouts diferentes.
      'x-idempotency-key': request.id,
    },
    body: JSON.stringify({
      amount: twoDecimals(request.amount), currency: 'USDC',
      description: `Anubis Router - credito US$ ${twoDecimals(request.amount)}`,
      metadata: { orderId: request.id },
      successRedirectUrl: returnUrl, failRedirectUrl: returnUrl,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.url !== 'string') throw new Error(`Coinbase recusou o checkout (HTTP ${response.status})`);
  return { provider: 'coinbase', redirect: payload.url, checkoutId: payload.id || payload.uuid || null };
}

/** Confere X-Webhook-Signature: t=<s>,h=<cabeçalhos>,v0=<hex>,v1=<hex>; v0 = HMAC-SHA256("{t}.{corpo}"). */
export function verifyCoinbaseSignature(secret, raw, headers, now = Math.floor(Date.now() / 1000)) {
  const header = String(headers?.['x-webhook-signature'] || headers?.['x-hook0-signature'] || '');
  const parts = Object.fromEntries(header.split(',').map(item => { const index = item.indexOf('='); return [item.slice(0, index).trim(), item.slice(index + 1).trim()]; }));
  const timestamp = Number(parts.t);
  if (!Number.isSafeInteger(timestamp)) return 'Assinatura da Coinbase ausente.';
  if (Math.abs(now - timestamp) > MAX_AGE_SECONDS) return 'Assinatura da Coinbase vencida.';
  const equal = (expected, given) => { const a = Buffer.from(expected); const b = Buffer.from(String(given || '').toLowerCase()); return a.length === b.length && timingSafeEqual(a, b); };
  if (parts.v0 && equal(createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex'), parts.v0)) return null;
  // v1 também assina os cabeçalhos listados em h, unidos por ".".
  if (parts.v1) {
    const names = (parts.h || '').split(' ').filter(Boolean);
    const values = names.map(name => String(headers?.[name.toLowerCase()] ?? '')).join('.');
    if (equal(createHmac('sha256', secret).update(`${parts.t}.${parts.h || ''}.${values}.${raw}`).digest('hex'), parts.v1)) return null;
  }
  return 'Assinatura da Coinbase inválida.';
}

/** Só checkout.payment.success concluído, em USDC e com o mesmo valor do pedido, credita. */
export function evaluateCoinbaseNotify(config, data, request, { raw = '', headers = {}, now } = {}) {
  const invalid = verifyCoinbaseSignature(config.webhookSecret, raw, headers, now);
  if (invalid) return { error: invalid };
  const reference = String(data?.transactionHash || data?.id || '').slice(0, 120);
  if (!request) return { approve: false, reason: 'pedido_desconhecido', reference };
  if (data.eventType !== 'checkout.payment.success' || data.status !== 'COMPLETED') return { approve: false, reason: `evento_${data.eventType || data.status || 'vazio'}`, reference };
  // O pedido é em dólar e o checkout em USDC (1 USDC = 1 dólar na Coinbase).
  if (data.currency !== 'USDC' || request.currency !== 'USD') return { approve: false, reason: 'moeda_divergente', reference };
  if (twoDecimals(data.amount) !== twoDecimals(request.amount)) return { approve: false, reason: 'valor_divergente', reference };
  return { approve: true, reason: null, reference, method: data.network ? `USDC ${data.network}` : 'USDC' };
}

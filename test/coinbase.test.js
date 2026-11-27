import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { coinbaseConfig, coinbaseJwt, coinbaseCheckout, verifyCoinbaseSignature, evaluateCoinbaseNotify } from '../src/coinbase.js';

// Chave Ed25519 de teste no formato da CDP: base64 de semente (32 bytes) + chave pública (32 bytes).
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const env = { COINBASE_API_KEY_NAME: 'organizations/org-1/apiKeys/key-1', COINBASE_API_KEY_SECRET: Buffer.concat([seed, pub]).toString('base64'), COINBASE_WEBHOOK_SECRET: 'segredo-webhook' };
const config = coinbaseConfig(env);
const signed = (body, t = Math.floor(Date.now() / 1000), secret = env.COINBASE_WEBHOOK_SECRET) => ({ 'x-webhook-signature': `t=${t},h=,v0=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}` });

test('configuração exige as três variáveis', () => {
  assert.equal(coinbaseConfig({}), null);
  assert.equal(coinbaseConfig({ ...env, COINBASE_WEBHOOK_SECRET: '' }), null);
  assert.equal(config.keyName, env.COINBASE_API_KEY_NAME);
});

test('JWT EdDSA de 2 minutos para a chamada, verificável pela chave pública', () => {
  const token = coinbaseJwt(config, 'POST', '/api/v1/checkouts', 1_000_000);
  const [h, c, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepEqual([header.alg, header.typ, header.kid], ['EdDSA', 'JWT', env.COINBASE_API_KEY_NAME]);
  assert.match(header.nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual(claims, { sub: env.COINBASE_API_KEY_NAME, iss: 'cdp', aud: ['cdp_service'], nbf: 1_000_000, exp: 1_000_120, uri: 'POST business.coinbase.com/api/v1/checkouts' });
  assert.equal(verify(null, Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')), true);
});

test('checkout em USDC com o pedido nos metadados e chave de idempotência', async () => {
  let sent = null;
  const fetcher = async (url, options) => { sent = { url, options }; return new Response(JSON.stringify({ id: 'chk_1', url: 'https://payments.coinbase.com/payment-links/pl_1' }), { status: 201 }); };
  const result = await coinbaseCheckout(config, { id: 'req-1', amount: '20', currency: 'USD' }, { returnUrl: 'https://site/minha-conta', fetcher });
  assert.deepEqual(result, { provider: 'coinbase', redirect: 'https://payments.coinbase.com/payment-links/pl_1', checkoutId: 'chk_1' });
  assert.equal(sent.url, 'https://business.coinbase.com/api/v1/checkouts');
  assert.match(sent.options.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(sent.options.headers['x-idempotency-key'], 'req-1');
  assert.deepEqual(JSON.parse(sent.options.body), { amount: '20.00', currency: 'USDC', description: 'Anubis Router - credito US$ 20.00', metadata: { orderId: 'req-1' }, successRedirectUrl: 'https://site/minha-conta', failRedirectUrl: 'https://site/minha-conta' });
  await assert.rejects(coinbaseCheckout(config, { id: 'req-1', amount: '20' }, { fetcher: async () => new Response('{}', { status: 401 }) }), /HTTP 401/);
});

test('webhook: assinatura v0, prazo de 5 minutos e só pagamento concluído com o mesmo valor credita', () => {
  const body = JSON.stringify({ id: 'chk_1', eventType: 'checkout.payment.success', status: 'COMPLETED', amount: '20.00', currency: 'USDC', network: 'base', transactionHash: '0xabc', metadata: { orderId: 'req-1' } });
  const data = JSON.parse(body);
  const request = { id: 'req-1', amount: '20', currency: 'USD' };
  assert.equal(verifyCoinbaseSignature(env.COINBASE_WEBHOOK_SECRET, body, signed(body)), null);
  assert.match(verifyCoinbaseSignature(env.COINBASE_WEBHOOK_SECRET, body, signed(body, undefined, 'outro')), /inválida/);
  assert.match(verifyCoinbaseSignature(env.COINBASE_WEBHOOK_SECRET, body, signed(body, Math.floor(Date.now() / 1000) - 600)), /vencida/);
  assert.match(verifyCoinbaseSignature(env.COINBASE_WEBHOOK_SECRET, body, {}), /ausente/);
  assert.deepEqual(evaluateCoinbaseNotify(config, data, request, { raw: body, headers: signed(body) }), { approve: true, reason: null, reference: '0xabc', method: 'USDC base' });
  assert.equal(evaluateCoinbaseNotify(config, data, { ...request, amount: '25' }, { raw: body, headers: signed(body) }).reason, 'valor_divergente');
  const failed = JSON.stringify({ ...data, eventType: 'checkout.payment.failed', status: 'FAILED' });
  assert.equal(evaluateCoinbaseNotify(config, JSON.parse(failed), request, { raw: failed, headers: signed(failed) }).approve, false);
  assert.ok(evaluateCoinbaseNotify(config, data, request, { raw: body + ' ', headers: signed(body) }).error, 'corpo alterado não passa');
});

test('fluxo: webhook assinado da Coinbase credita o pedido uma vez só', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-coinbase-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], { env: { ...process.env, ...env, NODE_ENV: 'test', PORT: String(port), ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32), DATABASE_URL: '', PAYSSION_API_KEY: '', PAYSSION_SECRET_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.on('data', chunk => { if (/Anubis Router: http/.test(String(chunk))) resolve(); }); child.once('exit', code => reject(new Error(`server exited ${code}`))); });
  const base = `http://127.0.0.1:${port}`;
  const admin = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
  const created = await (await fetch(`${base}/admin/keys`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Cliente cripto' }) })).json();
  const client = { authorization: `Bearer ${created.key}`, 'content-type': 'application/json' };
  const credits = await (await fetch(`${base}/me/credits`, { headers: client })).json();
  assert.deepEqual(credits.checkout.gateways.map(g => g.id), ['coinbase']);
  const { request } = await (await fetch(`${base}/me/topup-requests`, { method: 'POST', headers: client, body: JSON.stringify({ amount: '20' }) })).json();
  const notify = body => fetch(`${base}/payments/coinbase/notify`, { method: 'POST', headers: { 'content-type': 'application/json', ...signed(body) }, body });
  const body = JSON.stringify({ id: 'chk_1', eventType: 'checkout.payment.success', status: 'COMPLETED', amount: '20.00', currency: 'USDC', network: 'base', transactionHash: '0xabc', metadata: { orderId: request.id } });
  assert.equal((await fetch(`${base}/payments/coinbase/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 400, 'sem assinatura');
  let result = await (await notify(body)).json();
  assert.deepEqual(result, { ok: true, credited: true });
  result = await (await notify(body)).json();
  assert.equal(result.reason, 'ja_creditado');
  const wallet = (await (await fetch(`${base}/me/credits`, { headers: client })).json()).wallet;
  assert.equal(wallet.balance, '20');
  assert.equal((await fetch(`${base}/payments/payssion/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404, 'gateway sem credencial não tem rota');
});

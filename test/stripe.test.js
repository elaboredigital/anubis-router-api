import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { stripeConfig, stripeCents, stripeCheckout, verifyStripeSignature, stripeOrderId, evaluateStripeNotify } from '../src/stripe.js';

const env = { STRIPE_SECRET_KEY: 'rk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_teste' };
const config = stripeConfig(env);
const signed = (body, t = Math.floor(Date.now() / 1000), secret = env.STRIPE_WEBHOOK_SECRET) => ({ 'stripe-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')},v0=ignorado` });
const event = (type, session) => ({ id: 'evt_1', type, data: { object: { id: 'cs_1', payment_intent: 'pi_1', currency: 'usd', amount_total: 2000, payment_status: 'paid', metadata: { orderId: 'req-1' }, payment_method_types: ['card'], ...session } } });

test('configuração exige chave rk_/sk_ e segredo whsec_', () => {
  assert.equal(stripeConfig({}), null);
  assert.equal(stripeConfig({ STRIPE_SECRET_KEY: 'pk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }), null, 'chave publicável não serve');
  assert.equal(stripeConfig({ ...env, STRIPE_WEBHOOK_SECRET: 'x' }), null);
  assert.deepEqual([config.live, stripeConfig({ ...env, STRIPE_SECRET_KEY: 'sk_live_x' }).live], [false, true]);
});

test('centavos sem erro de ponto flutuante', () => {
  assert.deepEqual(['5', '20', '19.9', '10.05', '0.1'].map(stripeCents), [500, 2000, 1990, 1005, 10]);
});

test('checkout cria sessão em USD com o pedido e chave de idempotência', async () => {
  let sent = null;
  const fetcher = async (url, options) => { sent = { url, options }; return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }), { status: 200 }); };
  const result = await stripeCheckout(config, { id: 'req-1', amount: '20', currency: 'USD' }, { returnUrl: 'https://site/minha-conta?pagamento=retorno', fetcher });
  assert.deepEqual(result, { provider: 'stripe', redirect: 'https://checkout.stripe.com/c/pay/cs_1', checkoutId: 'cs_1' });
  assert.equal(sent.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(sent.options.headers.authorization, 'Bearer rk_test_abc123');
  const key = sent.options.headers['idempotency-key'];
  assert.match(key, /^anubis-req-1-[0-9a-f]{16}$/);
  // Mesmos parâmetros, mesma chave (clique duplo); outra URL de retorno, outra chave (a Stripe recusaria com 400).
  await stripeCheckout(config, { id: 'req-1', amount: '20', currency: 'USD' }, { returnUrl: 'https://site/minha-conta?pagamento=retorno', fetcher });
  assert.equal(sent.options.headers['idempotency-key'], key);
  await stripeCheckout(config, { id: 'req-1', amount: '20', currency: 'USD' }, { returnUrl: 'https://site/es/panel/account?pagamento=retorno', fetcher });
  assert.notEqual(sent.options.headers['idempotency-key'], key);
  const form = new URLSearchParams(sent.options.body);
  assert.deepEqual([form.get('mode'), form.get('line_items[0][price_data][currency]'), form.get('line_items[0][price_data][unit_amount]'), form.get('metadata[orderId]'), form.get('client_reference_id')], ['payment', 'usd', '2000', 'req-1', 'req-1']);
  await assert.rejects(stripeCheckout(config, { id: 'req-1', amount: '20' }, { fetcher: async () => new Response('{"error":{"code":"api_key_expired"}}', { status: 401 }) }), /HTTP 401, api_key_expired/);
});

test('webhook: assinatura v1, prazo de 5 minutos, pago agora ou depois credita, valor precisa bater', () => {
  const request = { id: 'req-1', amount: '20', currency: 'USD' };
  const ok = JSON.stringify(event('checkout.session.completed'));
  assert.equal(verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, ok, signed(ok)), null);
  assert.match(verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, ok, signed(ok, undefined, 'whsec_outro')), /inválida/);
  assert.match(verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, ok, signed(ok, Math.floor(Date.now() / 1000) - 600)), /vencida/);
  assert.match(verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, ok, {}), /ausente/);
  assert.equal(stripeOrderId(JSON.parse(ok)), 'req-1');
  assert.deepEqual(evaluateStripeNotify(config, JSON.parse(ok), request, { raw: ok, headers: signed(ok) }), { approve: true, reason: null, reference: 'pi_1', method: 'card' });
  const unpaid = JSON.stringify(event('checkout.session.completed', { payment_status: 'unpaid' }));
  assert.equal(evaluateStripeNotify(config, JSON.parse(unpaid), request, { raw: unpaid, headers: signed(unpaid) }).approve, false, 'boleto ainda não pago');
  const later = JSON.stringify(event('checkout.session.async_payment_succeeded', { payment_status: 'paid' }));
  assert.equal(evaluateStripeNotify(config, JSON.parse(later), request, { raw: later, headers: signed(later) }).approve, true);
  const other = JSON.stringify(event('checkout.session.completed', { amount_total: 1000 }));
  assert.equal(evaluateStripeNotify(config, JSON.parse(other), request, { raw: other, headers: signed(other) }).reason, 'valor_divergente');
  assert.ok(evaluateStripeNotify(config, JSON.parse(ok), request, { raw: ok + ' ', headers: signed(ok) }).error, 'corpo alterado não passa');
});

test('fluxo: webhook assinado da Stripe credita o pedido uma vez só', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-stripe-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], { env: { ...process.env, ...env, NODE_ENV: 'test', PORT: String(port), ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32), DATABASE_URL: '', PAYSSION_API_KEY: '', COINBASE_API_KEY_NAME: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.on('data', chunk => { if (/Anubis Router: http/.test(String(chunk))) resolve(); }); child.once('exit', code => reject(new Error(`server exited ${code}`))); });
  const base = `http://127.0.0.1:${port}`;
  const admin = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
  const created = await (await fetch(`${base}/admin/keys`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Cliente cartão' }) })).json();
  const client = { authorization: `Bearer ${created.key}`, 'content-type': 'application/json' };
  assert.deepEqual((await (await fetch(`${base}/me/credits`, { headers: client })).json()).checkout.gateways.map(g => g.id), ['stripe']);
  const { request } = await (await fetch(`${base}/me/topup-requests`, { method: 'POST', headers: client, body: JSON.stringify({ amount: '20' }) })).json();
  const body = JSON.stringify(event('checkout.session.completed', { metadata: { orderId: request.id } }));
  const notify = () => fetch(`${base}/payments/stripe/notify`, { method: 'POST', headers: { 'content-type': 'application/json', ...signed(body) }, body });
  assert.equal((await fetch(`${base}/payments/stripe/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 400, 'sem assinatura');
  assert.deepEqual(await (await notify()).json(), { ok: true, credited: true });
  assert.equal((await (await notify()).json()).reason, 'ja_creditado');
  assert.equal((await (await fetch(`${base}/me/credits`, { headers: client })).json()).wallet.balance, '20');
});

test('cobrança em reais: valor convertido no checkout e webhook aceita o valor gravado no pedido', async () => {
  const brl = stripeConfig({ ...env, STRIPE_CURRENCY: 'brl' });
  assert.equal(brl.currency, 'brl');
  assert.equal(stripeConfig(env).currency, 'usd', 'padrão é dólar');
  let sent = null;
  const fetcher = async (url, options) => { sent = { url, options }; return new Response(JSON.stringify({ id: 'cs_2', url: 'https://checkout.stripe.com/c/pay/cs_2' }), { status: 200 }); };
  await stripeCheckout(brl, { id: 'req-2', amount: '1', currency: 'USD' }, { returnUrl: 'https://site/pt-br/panel/account', fetcher, charge: { currency: 'brl', amount: 538 } });
  const form = new URLSearchParams(sent.options.body);
  assert.deepEqual([form.get('line_items[0][price_data][currency]'), form.get('line_items[0][price_data][unit_amount]')], ['brl', '538']);
  const request = { id: 'req-2', amount: '1', currency: 'USD', charges: [{ currency: 'brl', amount: 530 }, { currency: 'brl', amount: 538 }] };
  const notify = (amount, currency = 'brl') => {
    const event = { type: 'checkout.session.completed', data: { object: { id: 'cs_2', payment_status: 'paid', currency, amount_total: amount, metadata: { orderId: 'req-2' } } } };
    const raw = JSON.stringify(event); const t = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', brl.webhookSecret).update(`${t}.${raw}`).digest('hex');
    return evaluateStripeNotify(brl, event, request, { raw, headers: { 'stripe-signature': `t=${t},v1=${signature}` } });
  };
  assert.equal(notify(538).approve, true);
  assert.equal(notify(530).approve, true, 'checkout anterior do mesmo pedido, com outra cotação, também vale');
  assert.equal(notify(500).reason, 'valor_divergente');
  assert.equal(notify(100, 'usd').approve, true, 'em dólar, o valor do pedido continua valendo');
  assert.equal(notify(538, 'eur').reason, 'moeda_divergente');
});

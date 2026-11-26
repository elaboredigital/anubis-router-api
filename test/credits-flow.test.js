import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateTopupRequest, clientStatement, spendByModel, ensureCreditPlan, CREDIT_PLAN, paymentSignature, verifyPaymentSignature } from '../src/credits.js';
import { buildWallets } from '../src/topup.js';

test('pedido de recarga aceita de US$ 5 a 10.000 com até duas casas e limita pendências', () => {
  assert.deepEqual(validateTopupRequest({ amount: '10' }), { amount: '10', currency: 'USD' });
  assert.deepEqual(validateTopupRequest({ amount: 25.5 }), { amount: '25.5', currency: 'USD' });
  assert.match(validateTopupRequest({ amount: '4.99' }).error, /mínima/);
  assert.match(validateTopupRequest({ amount: '10001' }).error, /máxima/);
  assert.match(validateTopupRequest({ amount: '5.001' }).error, /duas casas/);
  assert.match(validateTopupRequest({ amount: '-5' }).error, /duas casas/);
  assert.match(validateTopupRequest({ amount: '10' }, 3).error, /aguardando/);
});

test('plano de créditos é criado uma vez e respeita plano existente com o mesmo ID', () => {
  assert.equal(ensureCreditPlan([]).find(plan => plan.id === 'credits').kind, 'payg');
  const custom = [{ ...CREDIT_PLAN, name: 'Meu plano' }];
  assert.equal(ensureCreditPlan(custom), custom);
});

test('carteira é da conta: chave filha gasta o saldo da principal', () => {
  const keys = [{ id: 'root', name: 'Ana', planId: 'credits' }, { id: 'child', name: 'Ana CI', planId: 'credits', parentId: 'root' }];
  const plans = [CREDIT_PLAN];
  const wallets = buildWallets(keys, plans, [{ id: 't', keyId: 'root', amount: '10', currency: 'USD' }],
    [{ id: 'e1', keyId: 'child', status: 'settled', sale: '0.25', saleCurrency: 'USD' }, { id: 'e2', keyId: 'root', status: 'settled', sale: '0.75', saleCurrency: 'USD' }]);
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].keyId, 'root');
  assert.equal(wallets[0].balance, '9');
  assert.equal(wallets[0].requests, 2);
  // Só a filha informada: o saldo continua no ID da conta.
  const alone = buildWallets([keys[1]], plans, [{ id: 't', keyId: 'root', amount: '10', currency: 'USD' }], []);
  assert.equal(alone[0].keyId, 'root');
});

test('extrato mostra só chamadas da conta, sem custo nem margem', () => {
  const keys = [{ id: 'root', name: 'Ana' }];
  const entries = [
    { requestId: 'a', keyId: 'root', status: 'settled', sale: '0.5', saleCurrency: 'USD', cost: '0.1', margin: '0.4', publicModel: 'm1', startedAt: '2026-11-26T10:00:00Z' },
    { requestId: 'b', keyId: 'root', status: 'settled', sale: '0.25', saleCurrency: 'USD', cost: '0.05', publicModel: 'm1', startedAt: '2026-11-26T11:00:00Z' },
    { requestId: 'c', keyId: 'other', status: 'settled', sale: '9', saleCurrency: 'USD', publicModel: 'm2', startedAt: '2026-11-26T12:00:00Z' },
  ];
  const statement = clientStatement(entries, keys);
  assert.deepEqual(statement.map(item => item.requestId), ['b', 'a']);
  assert.doesNotMatch(JSON.stringify(statement), /cost|margin|0\.1"/);
  assert.deepEqual(spendByModel(statement), [{ model: 'm1', currency: 'USD', amount: '0.75', requests: 2 }]);
});

test('fluxo de créditos: cliente pede recarga, admin aprova, chamada desconta do saldo e falha troca de fornecedor', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-credits-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const calls = [];
  const mock = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(req.url.startsWith('/v1/models')
        ? { data: [{ id: 'remote/model', display_name: 'Modelo', modality: 'chat', billing_type: 'request', pricing: { request: '0.02', currency: 'USD' } }, { id: 'remote/down', display_name: 'Fora do ar', modality: 'chat', billing_type: 'request', pricing: { request: '0.04', currency: 'USD' } }] }
        : { object: 'usage', plan: 'free' }));
    }
    let text = ''; for await (const chunk of req) text += chunk;
    const model = JSON.parse(text).model; calls.push(model);
    if (model === 'remote/down') { res.writeHead(503); return res.end('indisponível'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'r', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], { env: { ...process.env, NODE_ENV: 'test', PORT: String(port), TEST_UPSTREAM_URL: `http://127.0.0.1:${mock.address().port}`, ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32), DATABASE_URL: '', ANUBIS_PAYMENT_WEBHOOK_SECRET: 'segredo-de-teste-com-mais-de-32-caracteres', PAYSSION_API_KEY: 'pk_teste', PAYSSION_SECRET_KEY: 'sk_teste', PAYSSION_SANDBOX: 'true', ANUBIS_SITE_URL: 'https://site.example' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => mock.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`server exited ${code}`))); });
  const base = `http://127.0.0.1:${port}`;
  const admin = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
  const post = (url, data, headers = admin) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(data) });

  let response = await post('/admin/connections', { provider: 'xkiro', name: 'principal', key: 'upstream-12345678901234' });
  assert.equal(response.status, 201); const connection = (await response.json()).connection;
  // Duas rotas para o mesmo modelo: a de maior prioridade está fora do ar.
  response = await post('/admin/routes', { id: 'anubis/teste', provider: 'xkiro', connectionId: connection.id, upstreamModel: 'remote/down', enabled: true, priority: 1 });
  assert.equal(response.status, 200);
  response = await post('/admin/routes', { id: 'anubis/teste', provider: 'xkiro', connectionId: connection.id, upstreamModel: 'remote/model', enabled: true, priority: 2 });
  assert.equal(response.status, 200);

  response = await fetch(`${base}/admin/plans`, { headers: admin });
  assert.ok((await response.json()).plans.some(plan => plan.id === 'credits' && plan.kind === 'payg'));
  response = await post('/admin/keys', { name: 'Cliente Ana' });
  assert.equal(response.status, 201); const created = await response.json();
  const client = { authorization: `Bearer ${created.key}`, 'content-type': 'application/json' };
  const call = () => post('/v1/chat/completions', { model: 'anubis/teste', messages: [{ role: 'user', content: 'oi' }] }, client);

  response = await call();
  assert.equal(response.status, 402, 'chave nova começa sem saldo');
  assert.equal((await response.json()).error.type, 'insufficient_balance');

  response = await post('/me/topup-requests', { amount: '3' }, client); assert.equal(response.status, 400);
  response = await post('/me/topup-requests', { amount: '10' }, client); assert.equal(response.status, 201);
  const request = (await response.json()).request;
  assert.equal(request.status, 'pending');
  response = await fetch(`${base}/me/credits`, { headers: client });
  let credits = await response.json();
  assert.equal(credits.wallet.balance, '0');
  assert.deepEqual(credits.presets, ['5', '10', '25', '50', '100']);
  assert.equal(credits.requests[0].status, 'pending');

  assert.equal((await post(`/admin/topup-requests/${request.id}/approve`, {}, client)).status, 401);
  response = await fetch(`${base}/admin/topup-requests`, { headers: admin });
  assert.equal((await response.json()).pending, 1);
  response = await post(`/admin/topup-requests/${request.id}/approve`, { note: 'PIX confirmado' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).wallet.balance, '10');
  assert.equal((await post(`/admin/topup-requests/${request.id}/approve`, {})).status, 409, 'aprovar duas vezes não credita de novo');

  calls.length = 0;
  response = await call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-anubis-fallback'), 'true');
  assert.deepEqual(calls, ['remote/down', 'remote/model']);
  await response.text();

  // Venda = média do custo das duas rotas (0,02 e 0,04) × 5 = 0,15 por requisição.
  let balance = null;
  for (let i = 0; i < 20 && balance !== '9.85'; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    credits = await (await fetch(`${base}/me/credits`, { headers: client })).json();
    balance = credits.wallet.balance;
  }
  assert.equal(balance, '9.85');
  assert.equal(credits.statement.length, 1);
  assert.equal(credits.statement[0].amount, '0.15');
  assert.equal(credits.statement[0].model, 'anubis/teste');
  assert.doesNotMatch(JSON.stringify(credits), /remote\/|xkiro|upstream|cost|margin/);

  response = await post('/me/topup-requests', { amount: '5' }, client);
  const second = (await response.json()).request;
  response = await post(`/admin/topup-requests/${second.id}/reject`, { note: 'Pagamento não encontrado' });
  assert.equal(response.status, 200);
  credits = await (await fetch(`${base}/me/credits`, { headers: client })).json();
  assert.equal(credits.wallet.balance, '9.85');
  assert.equal(credits.requests.find(item => item.id === second.id).reason, 'Pagamento não encontrado');

  // Confirmação automática: gateway assina o corpo; valor precisa bater; reenvio não credita de novo.
  const secret = 'segredo-de-teste-com-mais-de-32-caracteres';
  const confirm = (data, signer = secret, at = Date.now()) => {
    const raw = JSON.stringify(data);
    return fetch(`${base}/payments/confirm`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anubis-timestamp': String(at), 'x-anubis-signature': paymentSignature(signer, String(at), raw) }, body: raw });
  };
  response = await post('/me/topup-requests', { amount: '25' }, client);
  const paid = (await response.json()).request;
  assert.equal((await confirm({ requestId: paid.id, amount: '25', currency: 'USD', reference: 'pix-123' }, 'outro-segredo-qualquer-com-32-caracteres!')).status, 401);
  assert.equal((await confirm({ requestId: paid.id, amount: '25', currency: 'USD', reference: 'pix-123' }, secret, Date.now() - 10 * 60_000)).status, 401);
  assert.equal((await confirm({ requestId: paid.id, amount: '20', currency: 'USD', reference: 'pix-123' })).status, 400);
  response = await confirm({ requestId: paid.id, amount: '25', currency: 'USD', reference: 'pix-123', provider: 'teste' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).request.status, 'approved');
  response = await confirm({ requestId: paid.id, amount: '25', currency: 'USD', reference: 'pix-123' });
  assert.equal(response.status, 200); assert.equal((await response.json()).duplicate, true);
  assert.equal((await confirm({ requestId: paid.id, amount: '25', currency: 'USD', reference: 'pix-999' })).status, 409);
  credits = await (await fetch(`${base}/me/credits`, { headers: client })).json();
  assert.equal(credits.wallet.balance, '34.85', 'recarga confirmada entra uma única vez');

  // Payssion: checkout da página hospedada e notificação assinada (md5 com campos separados por "|").
  const md5 = text => createHash('md5').update(text).digest('hex');
  response = await post('/me/topup-requests', { amount: '50' }, client);
  const viaPayssion = (await response.json()).request;
  response = await post(`/me/topup-requests/${viaPayssion.id}/checkout`, {}, client);
  assert.equal(response.status, 200);
  const checkout = await response.json();
  assert.equal(checkout.action, 'http://sandbox.payssion.com/checkout/pk_teste');
  assert.equal(checkout.fields.amount, '50.00');
  assert.equal(checkout.fields.order_id, viaPayssion.id);
  assert.equal(checkout.fields.api_sig, md5(['pk_teste', '50.00', 'USD', viaPayssion.id, 'sk_teste'].join('|')));
  assert.equal(checkout.fields.return_url, 'https://site.example/minha-conta?pagamento=retorno');
  assert.doesNotMatch(JSON.stringify(checkout), /sk_teste/);
  const notify = (state, amount = '50.00', sig) => {
    const data = { app_name: 'anubis', pm_id: 'pix_br', transaction_id: 'T123', order_id: viaPayssion.id, amount, paid: amount, currency: 'USD', state };
    data.notify_sig = sig || md5(['pk_teste', data.pm_id, data.amount, data.currency, data.order_id, data.state, 'sk_teste'].join('|'));
    return fetch(`${base}/payments/payssion/notify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
  };
  assert.equal((await notify('completed', '50.00', 'f'.repeat(32))).status, 400, 'assinatura errada');
  response = await notify('pending'); assert.equal(response.status, 200); assert.equal((await response.json()).credited, false);
  response = await notify('completed', '5.00'); assert.equal((await response.json()).reason, 'valor_divergente');
  response = await notify('completed'); assert.equal(response.status, 200); assert.equal((await response.json()).credited, true);
  response = await notify('completed'); assert.equal((await response.json()).credited, false, 'reenvio não credita de novo');
  credits = await (await fetch(`${base}/me/credits`, { headers: client })).json();
  assert.equal(credits.wallet.balance, '84.85');
  assert.equal(credits.checkout.enabled, true);
  assert.equal((await post(`/me/topup-requests/${viaPayssion.id}/checkout`, {}, client)).status, 409, 'pedido pago não gera novo checkout');
});

test('assinatura de pagamento exige segredo longo, janela de 5 minutos e HMAC correto', () => {
  const secret = 'x'.repeat(32); const raw = '{"a":1}'; const at = String(Date.now());
  assert.equal(verifyPaymentSignature({ secret, timestamp: at, signature: paymentSignature(secret, at, raw), raw }), null);
  assert.match(verifyPaymentSignature({ secret: 'curto', timestamp: at, signature: '', raw }), /desligada/);
  assert.match(verifyPaymentSignature({ secret, timestamp: at, signature: paymentSignature(secret, at, raw + ' '), raw }), /Assinatura/);
  assert.match(verifyPaymentSignature({ secret, timestamp: String(Date.now() - 6 * 60_000), signature: paymentSignature(secret, at, raw), raw }), /janela/);
});

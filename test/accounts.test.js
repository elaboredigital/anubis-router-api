import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashPassword, verifyPassword, validateSignup, findAccountByLogin, issueEmailToken, consumeEmailToken, createLimiter } from '../src/accounts.js';
import { buildEmail } from '../src/mailer.js';

test('senha usa scrypt com sal e confere só a senha certa', () => {
  const stored = hashPassword('senha-forte-1');
  assert.match(stored, /^scrypt\$16384\$/);
  assert.notEqual(stored, hashPassword('senha-forte-1'));
  assert.equal(verifyPassword('senha-forte-1', stored), true);
  assert.equal(verifyPassword('senha-forte-2', stored), false);
  assert.equal(verifyPassword('x', 'lixo'), false);
});

test('cadastro valida e-mail e senha, recusa duplicados e só entra pelo e-mail', () => {
  const accounts = [{ username: 'ana', email: 'ana@x.com' }];
  assert.deepEqual(validateSignup(accounts, { email: ' BIA@x.com ', password: '12345678' }), { email: 'bia@x.com', password: '12345678' });
  assert.match(validateSignup(accounts, { email: 'nao-email', password: '12345678' }).error, /e-mail/);
  assert.match(validateSignup(accounts, { email: 'z@x.com', password: '123' }).error, /senha/);
  assert.match(validateSignup(accounts, { email: 'zecazeca@x.com', password: 'ZecaZeca' }).error, /igual ao e-mail/);
  assert.equal(validateSignup(accounts, { email: 'ANA@x.com', password: '12345678' }).field, 'email');
  assert.equal(findAccountByLogin(accounts, 'ANA@X.com'), accounts[0]);
  assert.equal(findAccountByLogin(accounts, ' ana '), null, 'nome de usuário antigo não serve para entrar');
  assert.equal(findAccountByLogin(accounts, 'ninguem'), null);
});

test('token de e-mail é de uso único, por tipo e vence', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  const { value, tokens } = issueEmailToken([], { accountId: 'a1', type: 'magic', now });
  assert.equal(tokens.length, 1);
  assert.doesNotMatch(JSON.stringify(tokens), new RegExp(value));
  assert.match(consumeEmailToken(tokens, value, 'verify', now).error, /inválido/);
  const used = consumeEmailToken(tokens, value, 'magic', now + 1000);
  assert.equal(used.accountId, 'a1');
  assert.match(consumeEmailToken(used.tokens, value, 'magic', now).error, /já usado/);
  assert.match(consumeEmailToken(tokens, value, 'magic', now + 16 * 60_000).error, /vencido/);
  // Pedir outro link do mesmo tipo invalida o anterior.
  const again = issueEmailToken(tokens, { accountId: 'a1', type: 'magic', now });
  assert.equal(again.tokens.length, 1);
});

test('limite em memória conta eventos na janela', () => {
  const limiter = createLimiter(2, 1000);
  assert.equal(limiter.take('ip', 0), true);
  assert.equal(limiter.take('ip', 10), true);
  assert.equal(limiter.take('ip', 20), false);
  assert.equal(limiter.count('ip', 20), 2);
  assert.equal(limiter.take('ip', 1500), true);
  limiter.refund('ip');
  assert.equal(limiter.count('ip', 1500), 0, 'refund devolve o último evento');
});

test('e-mail escapa o link e não depende de nome de usuário', () => {
  const mail = buildEmail('verify', { link: 'https://site/confirmar?token=abc' });
  assert.match(mail.subject, /Confirme/);
  assert.doesNotMatch(mail.html, /Olá, /);
  assert.match(mail.text, /https:\/\/site\/confirmar\?token=abc/);
});

test('fluxo: Playground anônimo com cota, cadastro, confirmação, login por senha e por link, chave vinculada', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-accounts-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const mock = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(req.url.startsWith('/v1/models')
        ? { data: [{ id: 'remote/free', display_name: 'Grátis', modality: 'chat', billing_type: 'request', pricing: { request: '0', currency: 'USD' } }, { id: 'remote/paid', display_name: 'Pago', modality: 'chat', billing_type: 'request', pricing: { request: '0.02', currency: 'USD' } }] }
        : { object: 'usage', plan: 'free' }));
    }
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'r', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), TEST_UPSTREAM_URL: `http://127.0.0.1:${mock.address().port}`, ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32), DATABASE_URL: '', SMTP_HOST: '', ANUBIS_SITE_URL: 'https://site.example', PLAYGROUND_MODELS: 'anubis/free', PLAYGROUND_FREE_MESSAGES: '2' };
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  t.after(async () => { child.kill(); await new Promise(resolve => mock.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`server exited ${code}`))); });
  child.stdout.on('data', chunk => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const admin = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
  const jsonHeaders = { 'content-type': 'application/json' };
  const post = (url, data, headers = jsonHeaders) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(data) });
  const lastLink = async kind => {
    for (let i = 0; i < 40; i++) {
      const found = [...log.matchAll(new RegExp(`\\] ${kind} para \\S+: (\\S+)`, 'g'))].at(-1);
      if (found) { log = ''; return new URL(found[1]); }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`link ${kind} não apareceu no log`);
  };

  let response = await post('/admin/connections', { provider: 'xkiro', name: 'principal', key: 'upstream-12345678901234' }, admin);
  const connection = (await response.json()).connection;
  for (const [id, upstreamModel] of [['anubis/free', 'remote/free'], ['anubis/paid', 'remote/paid']]) {
    response = await post('/admin/routes', { id, provider: 'xkiro', connectionId: connection.id, upstreamModel, enabled: true }, admin);
    assert.equal(response.status, 200);
  }

  // Playground anônimo: só modelos grátis e duas mensagens por IP.
  response = await fetch(`${base}/public/playground`);
  assert.deepEqual(await response.json(), { models: ['anubis/free'], freeMessages: 2, remaining: 2 });
  const ask = model => post('/public/playground/chat/completions', { model, messages: [{ role: 'user', content: 'oi' }] });
  assert.equal((await ask('anubis/paid')).status, 403);
  response = await ask('anubis/free'); assert.equal(response.status, 200); assert.equal(response.headers.get('x-playground-remaining'), '1'); await response.text();
  response = await ask('anubis/free'); assert.equal(response.status, 200); await response.text();
  response = await ask('anubis/free');
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.type, 'login_required');

  // Cadastro: e-mail com link de confirmação; antes de confirmar não entra.
  response = await post('/account/signup', { email: 'ana@example.com', password: 'senha-da-ana' });
  assert.equal(response.status, 201);
  const verifyLink = await lastLink('verify');
  assert.equal(verifyLink.origin + verifyLink.pathname, 'https://site.example/confirmar');
  assert.equal((await post('/account/signup', { email: 'ANA@example.com', password: 'outra-senha-1' })).status, 409);
  response = await post('/account/login', { email: 'ana@example.com', password: 'senha-da-ana' });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).type, 'email_not_verified');

  response = await post('/account/verify', { token: verifyLink.searchParams.get('token') });
  assert.equal(response.status, 200);
  const verified = await response.json();
  assert.match(verified.token, /^anubis_acct_/);
  assert.equal(verified.account.email, 'ana@example.com');
  assert.equal('username' in verified.account, false);
  assert.equal(verified.account.emailVerified, true);
  assert.ok(verified.account.keyId, 'conta confirmada ganha chave raiz');
  assert.equal((await post('/account/verify', { token: verifyLink.searchParams.get('token') })).status, 400, 'link de confirmação é de uso único');

  // A sessão da conta abre a área do cliente e o gateway.
  const session = { authorization: `Bearer ${verified.token}`, 'content-type': 'application/json' };
  response = await fetch(`${base}/account/me`, { headers: session });
  assert.equal((await response.json()).account.email, 'ana@example.com');
  response = await fetch(`${base}/me/summary`, { headers: session });
  assert.equal(response.status, 200);
  response = await post('/v1/chat/completions', { model: 'anubis/free', messages: [{ role: 'user', content: 'oi' }] }, session);
  assert.equal(response.status, 200, 'modelo grátis funciona mesmo sem saldo'); await response.text();

  // Login por usuário ou e-mail; senha errada não revela se a conta existe.
  assert.equal((await post('/account/login', { login: 'ANA@example.com', password: 'senha-da-ana' })).status, 200);
  assert.equal((await post('/account/login', { email: 'ana@example.com', password: 'errada-123' })).status, 401);
  assert.equal((await post('/account/login', { email: 'ninguem@example.com', password: 'errada-123' })).status, 401);

  // Link mágico: resposta genérica, link de uso único.
  response = await post('/account/magic-link', { email: 'ana@example.com' });
  assert.equal(response.status, 200);
  const magic = await lastLink('magic');
  assert.equal(magic.pathname, '/entrar');
  response = await post('/account/magic-login', { token: magic.searchParams.get('token') });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).account.keyId, verified.account.keyId);
  assert.equal((await post('/account/magic-link', { email: 'ninguem@example.com' })).status, 200);

  // Sair encerra a sessão.
  assert.equal((await post('/account/logout', {}, session)).status, 200);
  assert.equal((await fetch(`${base}/account/me`, { headers: session })).status, 401);
  assert.equal((await fetch(`${base}/me/summary`, { headers: session })).status, 401);

  // Cliente atual vincula a chave principal no cadastro e mantém a mesma conta de saldo.
  response = await post('/admin/keys', { name: 'Cliente antigo' }, admin);
  const old = await response.json();
  assert.equal((await post('/account/signup', { email: 'bia@example.com', password: 'senha-da-bia', existingKey: 'anubis_errada' })).status, 400);
  response = await post('/account/signup', { email: 'bia@example.com', password: 'senha-da-bia', existingKey: old.key });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).linkedKey, true);
  response = await post('/account/verify', { token: (await lastLink('verify')).searchParams.get('token') });
  assert.equal((await response.json()).account.keyId, old.id);
  assert.equal((await post('/account/signup', { email: 'caio@example.com', password: 'senha-do-caio', existingKey: old.key })).status, 409, 'chave já vinculada');

  // Indicação real: o link público leva ao cadastro; a indicação nasce na confirmação e qualifica com a recarga aprovada.
  response = await post('/account/login', { email: 'ana@example.com', password: 'senha-da-ana' });
  const anaSession = { authorization: `Bearer ${(await response.json()).token}`, 'content-type': 'application/json' };
  const anaReferrals = async () => (await fetch(`${base}/me/referrals`, { headers: anaSession })).json();
  const refLink = new URL((await anaReferrals()).link);
  assert.equal(refLink.origin + refLink.pathname, 'https://site.example/cadastro');
  // Outra rede: o limite de cadastros por IP já foi usado acima.
  const otherNetwork = { ...jsonHeaders, 'x-forwarded-for': '203.0.113.7' };
  response = await post('/account/signup', { email: 'dani@example.com', password: 'senha-da-dani', ref: refLink.searchParams.get('ref').toLowerCase() }, otherNetwork);
  assert.equal(response.status, 201);
  assert.equal((await anaReferrals()).referrals.length, 0, 'só conta depois de confirmar o e-mail');
  response = await post('/account/verify', { token: (await lastLink('verify')).searchParams.get('token') });
  const dani = await response.json();
  let report = await anaReferrals();
  assert.equal(report.referrals.length, 1);
  assert.equal(report.referrals[0].status, 'cadastro');
  assert.doesNotMatch(JSON.stringify(report), /dani@example\.com/, 'o titular vê só o contato mascarado');
  assert.equal((await post('/account/verify', { token: 'x' })).status, 400);
  const daniSession = { authorization: `Bearer ${dani.token}`, 'content-type': 'application/json' };
  response = await post('/me/topup-requests', { amount: '10' }, daniSession);
  assert.equal(response.status, 201);
  const request = (await response.json()).request;
  assert.equal((await post(`/admin/topup-requests/${request.id}/approve`, {}, admin)).status, 200);
  report = await anaReferrals();
  assert.equal(report.referrals[0].status, 'qualificada');
  assert.equal(report.referrals[0].rewardAmount, '1.00');
  assert.equal(report.stats.qualified, 1);

  // Código inválido ou da própria chave não cria indicação.
  response = await post('/account/signup', { email: 'eva@example.com', password: 'senha-da-eva', ref: 'ZZZZZZZZZZ' }, otherNetwork);
  assert.equal(response.status, 201);
  await post('/account/verify', { token: (await lastLink('verify')).searchParams.get('token') });
  assert.equal((await anaReferrals()).referrals.length, 1);
});

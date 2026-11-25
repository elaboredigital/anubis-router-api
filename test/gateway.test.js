import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, cp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('gateway isola chaves, encaminha a rota e preserva streaming', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-test-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../public', path.join(dir, 'public'), { recursive: true }); await cp('package.json', path.join(dir, 'package.json'));
  let received;
  const attempts = [];
  const mock = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      if (!['Bearer upstream-12345678901234', 'Bearer upstream-SECOND-1234567'].includes(req.headers.authorization)) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(req.url.startsWith('/v1/models') ? { data: [{ id: 'remote/model', display_name: 'Modelo', modality: 'chat', billing_type: 'request', pricing: { request: '0.02', currency: 'USD' } }, { id: 'remote/image', modality: 'image' }] } : { object: 'usage', plan: 'free', wallet: { balance_usd: '9.50', held_usd: '0' }, free_tokens: { remaining: 1234, limit_per_day: 5000 }, user: { email: 'private@example.invalid' } }));
    }
    let text = ''; for await (const chunk of req) text += chunk;
    received = { headers: req.headers, path: req.url, body: JSON.parse(text) };
    attempts.push(received.body.model);
    if (received.body.model === 'remote/fail') { res.writeHead(429); return res.end('limit'); }
    if (received.body.model === 'remote/bad') { res.writeHead(400); return res.end('bad request'); }
    if (received.body.model === 'remote/partial') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: partial\n\n'); return setTimeout(() => res.destroy(), 20); }
    if (received.body.force_error) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'limit' } })); }
    if (received.body.model === 'remote/silent') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"resposta sem uso"}}]}\n\n'); return res.end('data: [DONE]\n\n'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n'); setTimeout(() => res.end('data: {"usage":{"prompt_tokens":100,"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":80}}}\n\ndata: [DONE]\n\n'), 30);
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123'; const providerKey = 'upstream-12345678901234';
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], { env: { ...process.env, NODE_ENV: 'test', PORT: String(port), TEST_UPSTREAM_URL: `http://127.0.0.1:${mock.address().port}`, ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => mock.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`server exited ${code}`))); });
  const base = `http://127.0.0.1:${port}`;
  for (const page of ['/', '/routes', '/models', '/providers', '/keys', '/topup']) { const pageResponse = await fetch(`${base}${page}`); assert.equal(pageResponse.status, 200); assert.match(await pageResponse.text(), /data-page="routes"/); }
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  assert.equal((await fetch(`${base}/admin/routes`, { headers: { authorization: 'Bearer invalid' } })).status, 401);
  const adminHeaders = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
  let priceResponse = await fetch(`${base}/admin/pricing`, { headers: adminHeaders });
  assert.equal((await priceResponse.json()).defaultMultiplier, '5');
  priceResponse = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'model', provider: 'xkiro', model: 'remote/model', multiplier: '2.5' }) });
  assert.equal((await priceResponse.json()).rules[0].multiplier, '2.5');
  priceResponse = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'default', multiplier: '0' }) }); assert.equal(priceResponse.status, 400);
  priceResponse = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'model', provider: 'xkiro', model: 'remote/model', multiplier: null }) });
  assert.equal((await priceResponse.json()).rules.length, 0);
  priceResponse = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'manual_model', provider: 'xkiro', model: 'mistralai/mistral-large-2512', price: { basis: 'per_1m_tokens', currency: 'USD', input: '0', output: '0.10' } }) });
  assert.equal(priceResponse.status, 200); assert.equal((await priceResponse.json()).manualPrices[0].price.output, '0.10');
  priceResponse = await fetch(`${base}/admin/pricing`, { headers: adminHeaders }); assert.equal((await priceResponse.json()).manualPrices[0].price.input, '0');
  priceResponse = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'manual_model', provider: 'xkiro', model: 'mistralai/mistral-large-2512', price: { basis: 'per_1m_tokens', currency: 'USD', input: '0', output: '0.10', cacheRead: '0.02', cacheWrite: '0.03' } }) });
  assert.equal(priceResponse.status, 200);
  const savedManual = (await priceResponse.json()).manualPrices[0].price;
  assert.equal(savedManual.cacheRead, '0.02'); assert.equal(savedManual.cacheWrite, '0.03');
  priceResponse = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'manual_model', provider: 'xkiro', model: 'mistralai/mistral-large-2512', price: { basis: 'per_1m_tokens', currency: 'USD', input: '0', output: '0.10', cacheRead: '-1' } }) });
  assert.equal(priceResponse.status, 400);
  priceResponse = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'manual_model', provider: 'xkiro', model: 'mistralai/mistral-large-2512', price: { basis: 'per_1m_tokens', currency: 'USD', input: '-1', output: '1' } }) });
  assert.equal(priceResponse.status, 400);
  priceResponse = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'manual_model', provider: 'xkiro', model: 'mistralai/mistral-large-2512', price: null }) });
  assert.equal((await priceResponse.json()).manualPrices.length, 0);
  priceResponse = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'manual_model', provider: 'wusrouter', model: 'example/free', price: { basis: 'per_request', currency: 'BRL', request: '0' } }) });
  assert.equal((await priceResponse.json()).manualPrices[0].price.request, '0');
  let response = await fetch(`${base}/admin/connections`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ provider: 'xkiro', name: 'inválida', key: 'invalid-key-123456789' }) });
  assert.equal(response.status, 400);
  response = await fetch(`${base}/admin/connections`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ provider: 'xkiro', name: 'primeira', key: providerKey }) });
  assert.equal(response.status, 201); const firstConnection = (await response.json()).connection; assert.equal(firstConnection.status, 'valid');
  response = await fetch(`${base}/admin/connections/${firstConnection.id}/provider-usage`, { method: 'POST', headers: adminHeaders, body: '{}' });
  const remoteUsage = await response.json(); assert.equal(remoteUsage.wallet.balance, '9.50'); assert.equal(remoteUsage.freeTokens.remaining, 1234); assert.equal(JSON.stringify(remoteUsage).includes('private@example.invalid'), false);
  response = await fetch(`${base}/admin/provider-accounts`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ connectionId: firstConnection.id, balance: '10', spent: '', currency: 'USD', billingMode: 'payg', plan: 'Teste', freeEndsAt: '' }) });
  assert.equal(response.status, 200); const baseline = (await response.json()).account.balanceAsOf;
  response = await fetch(`${base}/admin/provider-accounts`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ connectionId: firstConnection.id, balance: '10', spent: '', currency: 'USD', billingMode: 'payg', plan: 'Teste alterado', freeEndsAt: '' }) });
  assert.equal((await response.json()).account.balanceAsOf, baseline);
  response = await fetch(`${base}/admin/connections`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ provider: 'xkiro', name: 'segunda', key: 'upstream-SECOND-1234567' }) });
  assert.equal(response.status, 201); const secondConnection = (await response.json()).connection;
  response = await fetch(`${base}/admin/connections/${firstConnection.id}/models`, { headers: adminHeaders });
  assert.equal((await response.json()).models.length, 2);
  response = await fetch(`${base}/admin/connections/${firstConnection.id}/models`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: 'remote/model', enabled: true }) }); assert.equal(response.status, 200);
  response = await fetch(`${base}/admin/connections/${firstConnection.id}/models`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: 'remote/image', enabled: true }) }); assert.equal(response.status, 400);
  response = await fetch(`${base}/admin/connections/${secondConnection.id}/models`, { headers: adminHeaders });
  assert.equal((await response.json()).models.find(m => m.id === 'remote/model').enabled, false);
  assert.equal((await readFile(path.join(dir, 'data', 'credentials.json'), 'utf8')).includes(providerKey), false);
  response = await fetch(`${base}/admin/keys`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Claude Code' }) });
  assert.equal(response.status, 201); const created = await response.json(); const apiKey = created.key;
  assert.equal((await readFile(path.join(dir, 'data', 'api-keys.json'), 'utf8')).includes(apiKey), false);
  assert.equal((await fetch(`${base}/admin/routes`, { headers: { authorization: `Bearer ${apiKey}` } })).status, 401);
  response = await fetch(`${base}/admin/routes`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: 'meu/modelo', provider: 'xkiro', connectionId: firstConnection.id, upstreamModel: 'remote/model', enabled: true }) });
  assert.equal(response.status, 200);
  const diagnosis = await (await fetch(`${base}/admin/connect/diagnose`, { method: 'POST', headers: adminHeaders, body: '{}' })).json();
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.checks.find(c => c.id === 'authentication').ok, true);
  assert.equal(diagnosis.modelCount >= 1, true);
  response = await fetch(`${base}/admin/routes`, { headers: { authorization: `Bearer ${adminKey}` } });
  assert.equal(JSON.stringify(await response.json()).includes(providerKey), false);
  response = await fetch(`${base}/admin/routes`, { method: 'POST', headers: { ...adminHeaders, origin: 'https://exemplo.invalid' }, body: '{}' });
  assert.equal(response.status, 403);
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'meu/modelo', messages: [{ role: 'user', content: 'conteudo-privado-teste' }], stream: true }) });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.match(response.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/);
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let streamed = '';
  while (!streamed.includes('DONE')) { const chunk = await reader.read(); if (chunk.done) break; streamed += decoder.decode(chunk.value); }
  assert.match(streamed, /data: first/); assert.match(streamed, /DONE/);
  let summary;
  for (let n = 0; n < 30; n++) { summary = await (await fetch(`${base}/admin/usage`, { headers: adminHeaders })).json(); if (summary.groups[0]?.completed) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(summary.groups[0].requests, 1); assert.equal(summary.groups[0].inputTokens, 100); assert.equal(summary.groups[0].outputTokens, 12); assert.equal(summary.groups[0].cachedInputTokens, 80);
  const systemReport = await (await fetch(`${base}/admin/system`, { headers: adminHeaders })).json();
  assert.ok(systemReport.traffic.requestBytesTotal > 0);
  assert.ok(systemReport.traffic.responseBytesTotal > 0);
  assert.ok(systemReport.traffic.streamedResponsesCount >= 1);
  assert.equal(JSON.stringify(systemReport).includes('conteudo-privado-teste'), false);
  assert.equal(JSON.stringify(systemReport).includes(providerKey), false);
  assert.equal(JSON.stringify(systemReport).includes(apiKey), false);
  const keyReport = await (await fetch(`${base}/admin/keys`, { headers: adminHeaders })).json();
  const keyUsage = keyReport.keys.find(k => k.name === 'Claude Code').usage;
  assert.equal(keyUsage.inputTokens, 100); assert.equal(keyUsage.outputTokens, 12);
  assert.deepEqual(keyUsage.spend, [{ currency: 'USD', amount: '0.02' }]);
  const dashboard = await (await fetch(`${base}/admin/dashboard`, { headers: adminHeaders })).json();
  assert.equal(dashboard.accounts.find(a => a.connectionId === firstConnection.id).estimatedBalance, '9.98');
  const history = await readFile(path.join(dir, 'data', 'usage.jsonl'), 'utf8');
  assert.equal(history.includes('conteudo-privado-teste'), false); assert.equal(history.includes(providerKey), false); assert.equal(history.includes(apiKey), false);
  assert.equal(received.headers.authorization, `Bearer ${providerKey}`);
  assert.equal(received.body.model, 'remote/model'); assert.equal(received.path, '/v1/chat/completions');
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'meu/modelo', messages: [], force_error: true }) });
  assert.equal(response.status, 429); await response.text();
  for (let n = 0; n < 30; n++) { summary = await (await fetch(`${base}/admin/usage`, { headers: adminHeaders })).json(); if (summary.groups[0]?.failed) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(summary.groups[0].failed, 1); assert.equal(summary.groups[0].requests, 2); assert.equal(summary.groups[0].inputReported, 1);
  const failures = await (await fetch(`${base}/admin/gateway-failures`, { headers: adminHeaders })).json();
  assert.equal(failures.failureRate, 50);
  assert.equal(failures.attempts, 1);
  assert.ok(failures.recent.some(row => row.httpStatus === 429 && row.reason === 'resposta_http' && row.retryable === false));
  assert.equal(JSON.stringify(failures).includes('conteudo-privado-teste'), false);
  response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'meu/modelo', messages: [] }) });
  assert.equal(response.status, 200); await response.text(); assert.equal(received.headers['anthropic-version'], '2023-06-01');
  response = await fetch(`${base}/admin/connections/${secondConnection.id}/models`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: 'remote/model', enabled: true }) }); assert.equal(response.status, 200);
  response = await fetch(`${base}/admin/connections/${firstConnection.id}/toggle`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ active: false }) }); assert.equal(response.status, 200);
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'remote/model', messages: [] }) });
  assert.equal(response.status, 200); await response.text(); assert.equal(received.headers.authorization, 'Bearer upstream-SECOND-1234567');
  for (const [model, priority] of [['remote/fail', 1], ['remote/model', 2]]) {
    response = await fetch(`${base}/admin/routes`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: 'anubis/fallback', provider: 'xkiro', connectionId: secondConnection.id, upstreamModel: model, enabled: true, priority }) }); assert.equal(response.status, 200);
  }
  const configured = (await (await fetch(`${base}/admin/routes`, { headers: adminHeaders })).json()).routes.filter(r => r.id === 'anubis/fallback'); assert.equal(configured.length, 2);
  response = await fetch(`${base}/admin/routes`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...configured[0], priority: 3 }) }); assert.equal(response.status, 200);
  response = await fetch(`${base}/admin/routes`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...configured[0], priority: 1 }) }); assert.equal(response.status, 200);
  response = await fetch(`${base}/admin/connections/${secondConnection.id}/models`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: 'remote/model', enabled: true }) }); assert.equal(response.status, 200);
  assert.equal((await (await fetch(`${base}/admin/routes`, { headers: adminHeaders })).json()).routes.filter(r => r.id === 'anubis/fallback').length, 2);
  attempts.length = 0;
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'anubis/fallback', messages: [] }) });
  const fallbackRequestId = response.headers.get('x-request-id');
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-anubis-fallback'), 'true'); assert.equal(response.headers.get('x-anubis-model'), 'remote/model'); await response.text(); assert.deepEqual(attempts, ['remote/fail', 'remote/model']);
  const fallbackFailures = await (await fetch(`${base}/admin/gateway-failures`, { headers: adminHeaders })).json();
  assert.ok(fallbackFailures.recent.some(row => row.requestId === fallbackRequestId && row.attempt === 1 && row.httpStatus === 429 && row.retryable === true));
  for (const [id, model] of [['anubis/nonretry', 'remote/bad'], ['anubis/partial', 'remote/partial']]) {
    for (const [destination, priority] of [[model, 1], ['remote/model', 2]]) { response = await fetch(`${base}/admin/routes`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id, provider: 'xkiro', connectionId: secondConnection.id, upstreamModel: destination, enabled: true, priority }) }); assert.equal(response.status, 200); }
    attempts.length = 0; response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: id, messages: [] }) });
    if (model === 'remote/bad') { assert.equal(response.status, 400); await response.text(); } else { await assert.rejects(response.text()); }
    assert.deepEqual(attempts, [model]);
  }
  // Planos e limites por cliente: um plano com um modelo elegível e uma requisição por mês.
  response = await fetch(`${base}/admin/connections/${firstConnection.id}/toggle`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ active: true }) });
  assert.equal(response.status, 200);
  const planData = { name: 'Gratuito teste', kind: 'free', monthlyRequests: 1, monthlyTokens: 1000000, models: ['meu/modelo'], multiplier: null, active: true };
  response = await fetch(`${base}/admin/plans`, { method: 'POST', headers: adminHeaders, body: JSON.stringify(planData) });
  assert.equal(response.status, 201); const testPlan = (await response.json()).plan;
  response = await fetch(`${base}/admin/plans`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...planData, monthlyRequests: 0 }) });
  assert.equal(response.status, 400);
  response = await fetch(`${base}/admin/keys`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Chave com plano', planId: testPlan.id }) });
  assert.equal(response.status, 201);
  const planKeyCreated = await response.json(); const planKey = planKeyCreated.key;
  const planHeaders = { authorization: `Bearer ${planKey}`, 'content-type': 'application/json' };
  const allowedModels = await (await fetch(`${base}/v1/models`, { headers: planHeaders })).json();
  assert.deepEqual(allowedModels.data.map(item => item.id), ['meu/modelo']);
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: planHeaders, body: JSON.stringify({ model: 'remote/model', messages: [] }) });
  assert.equal(response.status, 403); await response.text();
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: planHeaders, body: JSON.stringify({ model: 'meu/modelo', messages: [] }) });
  assert.equal(response.status, 200); await response.text();
  let billing;
  for (let n = 0; n < 30; n++) {
    billing = (await (await fetch(`${base}/admin/keys`, { headers: adminHeaders })).json()).keys.find(item => item.name === 'Chave com plano').billing;
    if (billing.usage.requests >= 1) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(billing.usage.requests, 1); assert.equal(billing.limits.requests, 1);
  assert.equal(billing.sales.find(item => item.currency === 'USD').sale, '0.1');
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: planHeaders, body: JSON.stringify({ model: 'meu/modelo', messages: [] }) });
  assert.equal(response.status, 429); assert.match(JSON.stringify(await response.json()), /Limite de requisições/);
  response = await fetch(`${base}/admin/plans`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: testPlan.id, ...planData, monthlyRequests: 5, monthlyTokens: 1 }) });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: planHeaders, body: JSON.stringify({ model: 'meu/modelo', messages: [] }) });
  assert.equal(response.status, 429); assert.match(JSON.stringify(await response.json()), /Limite de tokens/);
  response = await fetch(`${base}/admin/plans`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: testPlan.id, ...planData, monthlyRequests: 5, monthlyTokens: 1000, active: false }) });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: planHeaders, body: JSON.stringify({ model: 'meu/modelo', messages: [] }) });
  assert.equal(response.status, 429); assert.match(JSON.stringify(await response.json()), /inativo/i);
  response = await fetch(`${base}/admin/plans`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: testPlan.id, ...planData, monthlyRequests: 5, monthlyTokens: 1000, multiplier: '3' }) });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: planHeaders, body: JSON.stringify({ model: 'meu/modelo', messages: [] }) });
  assert.equal(response.status, 200); await response.text();
  billing = (await (await fetch(`${base}/admin/keys`, { headers: adminHeaders })).json()).keys.find(item => item.name === 'Chave com plano').billing;
  // Duas chamadas concluídas a US$ 0,02: a simulação usa o multiplicador vigente do plano (3x), sem versionamento.
  assert.equal(billing.sales.find(item => item.currency === 'USD').sale, '0.12');
  assert.equal(billing.sales.find(item => item.currency === 'USD').marginPercent, 66.7);
  const plansReport = await (await fetch(`${base}/admin/plans`, { headers: adminHeaders })).json();
  assert.equal(plansReport.plans.length, 2); assert.equal(plansReport.providerUsage.length >= 1, true);
  response = await fetch(`${base}/admin/keys/plan`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: planKeyCreated.id, planId: null }) });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: planHeaders, body: JSON.stringify({ model: 'meu/modelo', messages: [] }) });
  assert.equal(response.status, 200); await response.text();

  // Ledger e preço versionado: cada chamada concluída fixa a versão vigente no início.
  assert.equal((await fetch(`${base}/admin/ledger`)).status, 401);
  let ledgerReport = await (await fetch(`${base}/admin/ledger`, { headers: adminHeaders })).json();
  assert.equal(ledgerReport.history[0].scope, 'default');
  assert.equal(ledgerReport.history[0].multiplier, '5');
  assert.equal(ledgerReport.history[0].effectiveAt, null);
  const firstEntry = ledgerReport.entries.find(item => item.keyId === planKeyCreated.id && item.multiplier === '5' && item.status === 'settled');
  assert.equal(firstEntry.cost, '0.02'); assert.equal(firstEntry.sale, '0.1'); assert.equal(firstEntry.marginPercent, 80);
  assert.equal(firstEntry.planId, testPlan.id); assert.equal(firstEntry.versionIds.includes('baseline-default'), true);
  const planEntry = ledgerReport.entries.find(item => item.keyId === planKeyCreated.id && item.multiplier === '3');
  assert.equal(planEntry.sale, '0.06');
  assert.equal(ledgerReport.summary.counts.pendingConversion, 0);
  assert.equal(ledgerReport.summary.counts.unpriced, 0);
  response = await fetch(`${base}/admin/pricing`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'default', multiplier: '4' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).defaultMultiplier, '4');
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'meu/modelo', messages: [] }) });
  assert.equal(response.status, 200); await response.text();
  for (let n = 0; n < 30; n++) {
    ledgerReport = await (await fetch(`${base}/admin/ledger`, { headers: adminHeaders })).json();
    if (ledgerReport.entries.some(item => item.keyId === created.id && item.multiplier === '4')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(ledgerReport.history.some(version => version.scope === 'default' && version.multiplier === '4' && version.effectiveAt !== null), true);
  const versionedEntry = ledgerReport.entries.find(item => item.keyId === created.id && item.multiplier === '4');
  assert.equal(versionedEntry.sale, '0.08');
  assert.equal(versionedEntry.versionIds.some(id => id !== 'baseline-default'), true);
  const reconcile = await (await fetch(`${base}/admin/ledger/reconcile`, { method: 'POST', headers: adminHeaders })).json();
  assert.equal(reconcile.added, 0);

  // PAYG: recarga manual, bloqueio 402 sem saldo e consumo apurado pela razão.
  response = await fetch(`${base}/admin/plans`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'PAYG teste', kind: 'payg', monthlyRequests: null, monthlyTokens: null, models: ['meu/modelo'], multiplier: null, currency: 'USD', active: true }) });
  assert.equal(response.status, 201); const paygPlan = (await response.json()).plan;
  response = await fetch(`${base}/admin/keys`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Chave PAYG', planId: paygPlan.id }) });
  assert.equal(response.status, 201); const paygCreated = await response.json();
  const paygHeaders = { authorization: `Bearer ${paygCreated.key}`, 'content-type': 'application/json' };
  const paygCall = () => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: paygHeaders, body: JSON.stringify({ model: 'meu/modelo', messages: [] }) });
  response = await paygCall(); assert.equal(response.status, 402);
  const blocked = await response.json();
  assert.equal(blocked.error.type, 'insufficient_balance'); assert.equal(blocked.error.required, '0.08');
  assert.equal((await fetch(`${base}/admin/topup`)).status, 401);
  response = await fetch(`${base}/admin/topup`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ keyId: paygCreated.id, amount: '0.1', currency: 'BRL' }) });
  assert.equal(response.status, 400);
  const topupBody = JSON.stringify({ keyId: paygCreated.id, amount: '0.1', currency: 'USD', note: 'recarga teste', idempotencyKey: 'topup-idempotente' });
  response = await fetch(`${base}/admin/topup`, { method: 'POST', headers: adminHeaders, body: topupBody });
  assert.equal(response.status, 201);
  const topped = await response.json();
  assert.equal(topped.duplicate, false); assert.equal(topped.wallet.balance, '0.1');
  response = await fetch(`${base}/admin/topup`, { method: 'POST', headers: adminHeaders, body: topupBody });
  assert.equal(response.status, 200); assert.equal((await response.json()).duplicate, true);
  // Crédito avulso em qualquer chave ativa, com moeda explícita quando não há plano PAYG.
  const freeKeyResponse = await fetch(`${base}/admin/keys`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Chave com crédito avulso', planId: testPlan.id }) });
  assert.equal(freeKeyResponse.status, 201); const freeKey = await freeKeyResponse.json();
  response = await fetch(`${base}/admin/topup`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ keyId: freeKey.id, amount: '7.5', currency: 'BRL', note: 'crédito avulso' }) });
  assert.equal(response.status, 201);
  const avulsoTopped = await response.json();
  assert.equal(avulsoTopped.topup.planId, testPlan.id);
  assert.equal(avulsoTopped.wallet.currency, 'BRL');
  assert.equal(avulsoTopped.wallet.balance, '7.5');
  const noPlanKeyResponse = await fetch(`${base}/admin/keys`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Chave sem plano', planId: null }) });
  assert.equal(noPlanKeyResponse.status, 201); const noPlanKey = await noPlanKeyResponse.json();
  response = await fetch(`${base}/admin/topup`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ keyId: noPlanKey.id, amount: '3', currency: 'EUR' }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).topup.planId, null);

  const topupReport = await (await fetch(`${base}/admin/topup`, { headers: adminHeaders })).json();
  assert.equal(topupReport.topups.length, 3); assert.equal(topupReport.topups[0].note, 'recarga teste');
  assert.equal(topupReport.wallets.find(item => item.keyId === paygCreated.id).balance, '0.1');
  assert.equal(topupReport.wallets.find(item => item.keyId === freeKey.id).balance, '7.5');
  assert.equal(topupReport.wallets.find(item => item.keyId === noPlanKey.id).balance, '3');
  const paygKeyReport = await (await fetch(`${base}/admin/keys`, { headers: adminHeaders })).json();
  assert.equal(paygKeyReport.keys.find(item => item.name === 'Chave PAYG').wallet.balance, '0.1');
  assert.equal(paygKeyReport.keys.find(item => item.name === 'Chave com crédito avulso').wallet.balance, '7.5');
  response = await paygCall(); assert.equal(response.status, 200); await response.text();
  let paygWallet;
  for (let n = 0; n < 30; n++) {
    paygWallet = (await (await fetch(`${base}/admin/topup`, { headers: adminHeaders })).json()).wallets.find(item => item.keyId === paygCreated.id);
    if (paygWallet.requests >= 1) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(paygWallet.consumed, '0.08'); assert.equal(paygWallet.balance, '0.02'); assert.equal(paygWallet.requests, 1);
  response = await paygCall(); assert.equal(response.status, 402); assert.equal((await response.json()).error.balance, '0.02');
  response = await fetch(`${base}/admin/keys/revoke`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: planKeyCreated.id }) });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/admin/keys/revoke`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: created.id }) });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } }); assert.equal(response.status, 401);

  // Franquia diária do extrato: tokens estimados quando o fornecedor free não informa uso e bloqueio no dia.
  response = await fetch(`${base}/admin/routes`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: 'remote/silent', provider: 'xkiro', connectionId: firstConnection.id, upstreamModel: 'remote/silent', enabled: true, priority: 1 }) });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/admin/plans`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Free diário', kind: 'free', monthlyRequests: null, monthlyTokens: null, dailyRequests: null, dailyTokens: 1, models: ['remote/silent'], multiplier: null, active: true }) });
  assert.equal(response.status, 201); const dailyPlan = (await response.json()).plan;
  response = await fetch(`${base}/admin/keys`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Chave diária', planId: dailyPlan.id }) });
  assert.equal(response.status, 201); const dailyKey = await response.json();
  const dailyHeaders = { authorization: `Bearer ${dailyKey.key}`, 'content-type': 'application/json' };
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: dailyHeaders, body: JSON.stringify({ model: 'remote/silent', messages: [{ role: 'user', content: 'oi' }] }) });
  assert.equal(response.status, 200); await response.text();
  let dailyBilling;
  for (let n = 0; n < 30; n++) {
    dailyBilling = (await (await fetch(`${base}/admin/keys`, { headers: adminHeaders })).json()).keys.find(item => item.name === 'Chave diária').billing;
    if (dailyBilling.usage.tokens > 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(dailyBilling.usage.tokens > 0, 'tokens estimados devem ser registrados');
  response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: dailyHeaders, body: JSON.stringify({ model: 'remote/silent', messages: [] }) });
  assert.equal(response.status, 429); assert.equal((await response.json()).error.reason, 'daily_tokens');

  // Franquia diária do fornecedor salva como backup do saldo.
  response = await fetch(`${base}/admin/provider-accounts`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ connectionId: firstConnection.id, balance: '10', spent: '', currency: 'USD', billingMode: 'payg', plan: 'Teste', freeEndsAt: '', dailyTokens: '500000', backup: true }) });
  assert.equal(response.status, 200);
  const providerReport = await (await fetch(`${base}/admin/dashboard`, { headers: adminHeaders })).json();
  const providerDaily = providerReport.accounts.find(item => item.connectionId === firstConnection.id).dailyUsage;
  assert.equal(providerDaily.limit, 500000); assert.equal(providerDaily.backup, true);
  assert.equal(providerDaily.tokens > 0, true);
  response = await fetch(`${base}/admin/provider-accounts`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ connectionId: firstConnection.id, balance: '10', spent: '', currency: 'USD', billingMode: 'payg', plan: 'Teste', freeEndsAt: '', dailyTokens: '0' }) });
  assert.equal(response.status, 400);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, cp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('resumo do cliente fica dentro do admin e expõe somente os dados da chave selecionada', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-client-home-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../public', path.join(dir, 'public'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const rawKey = 'anubis_cliente_abcdefghijkl';
  const otherRawKey = 'anubis_outro_abcdefghijkl';
  const hash = value => createHash('sha256').update(value).digest('hex');
  const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString();
  const plan = { id: 'p-payg', name: 'PAYG teste', kind: 'payg', currency: 'USD', active: true, monthlyRequests: 100, monthlyTokens: 1000000, models: ['anubis/mistral'], multiplier: null };
  const keys = [
    { id: 'k-client', name: 'Alan Diniz', prefix: 'anubis_cliente_', hash: hash(rawKey), active: true, createdAt: daysAgo(40), planId: plan.id },
    { id: 'k-other', name: 'Outro Cliente', prefix: 'anubis_outro___', hash: hash(otherRawKey), active: true, createdAt: daysAgo(40), planId: plan.id },
  ];
  const record = (id, keyId, model, at) => ({ id, requestId: id, attempt: 1, clientKeyId: keyId, planId: plan.id, startedAt: at, finishedAt: at, status: 'completed', publicModel: model, upstreamModel: model, usage: { inputTokens: 120, outputTokens: 80 }, costSnapshot: { currency: 'USD', request: '0.9' }, saleSnapshot: { multiplier: '5', versionIds: [] } });
  const records = [
    record('req-client', 'k-client', 'anubis/mistral', daysAgo(2)),
    record('req-other', 'k-other', 'outro/modelo', daysAgo(3)),
  ];
  const entry = (id, keyId, requestId, sale) => ({ id: `led-${id}`, requestId, keyId, planId: plan.id, status: 'settled', sale, saleCurrency: 'USD', currency: 'USD', cost: '0.9', publicModel: requestId === 'req-client' ? 'anubis/mistral' : 'outro/modelo', startedAt: daysAgo(2) });
  await mkdir(path.join(dir, 'data'), { recursive: true });
  await writeFile(path.join(dir, 'data', 'api-keys.json'), JSON.stringify(keys));
  await writeFile(path.join(dir, 'data', 'plans.json'), JSON.stringify([plan]));
  await writeFile(path.join(dir, 'data', 'usage.jsonl'), records.map(item => JSON.stringify(item)).join('\n') + '\n');
  await writeFile(path.join(dir, 'data', 'ledger.json'), JSON.stringify([entry('client', 'k-client', 'req-client', '4.5'), entry('other', 'k-other', 'req-other', '99')]));
  await writeFile(path.join(dir, 'data', 'topups.json'), JSON.stringify([{ id: 't1', keyId: 'k-client', planId: plan.id, amount: '10', currency: 'USD', createdAt: daysAgo(2) }]));

  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`servidor encerrou com ${code}`))); });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;

  for (const asset of ['/client-home', '/stats', '/system', '/app.js', '/style.css']) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200, asset);
    assert.match(await response.text(), /\S/);
  }
  for (const removed of ['/cliente', '/client.js', '/client.css', '/client/summary']) {
    assert.equal((await fetch(`${base}${removed}`)).status, 404, removed);
  }
  const pageHtml = await (await fetch(`${base}/client-home`)).text();
  assert.match(pageHtml, /data-page="client-home"/);
  assert.match(pageHtml, /data-nav="client-home"/);
  for (const id of ['client-home-key', 'client-balance', 'client-quota-bar', 'client-recent-rows', 'client-api-mask', 'client-scope']) {
    assert.match(pageHtml, new RegExp(`id="${id}"`));
  }
  assert.equal(pageHtml.includes('client-key'), false);
  assert.match(await (await fetch(`${base}/stats`)).text(), /Estatísticas por cliente/);
  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /'client-home': '\/client-home'/);
  assert.match(script, /api\(`\/admin\/client-summary\?keyId=/);
  assert.equal(script.includes('anubis-client-key'), false);

  const adminHeaders = { authorization: `Bearer ${adminKey}` };
  assert.equal((await fetch(`${base}/admin/client-summary?keyId=k-client`)).status, 401);
  assert.equal((await fetch(`${base}/admin/client-summary?keyId=k-client`, { headers: { authorization: `Bearer ${rawKey}` } })).status, 401);
  assert.equal((await fetch(`${base}/admin/client-summary?keyId=inexistente`, { headers: adminHeaders })).status, 400);

  const response = await fetch(`${base}/admin/client-summary?keyId=k-client`, { headers: adminHeaders });
  assert.equal(response.status, 200);
  const text = await response.text();
  const summary = JSON.parse(text);
  assert.equal(summary.account.name, 'Alan Diniz');
  assert.equal(summary.account.label, 'anubis_cliente_••••••••');
  assert.equal(summary.activity.requests30, 1);
  assert.equal(summary.activity.tokens30, 200);
  assert.equal(summary.spend.last30[0].amount, '4.5');
  assert.equal(summary.wallet.balance, '5.5');
  assert.equal(summary.recent[0].model, 'anubis/mistral');
  assert.equal(summary.recent[0].amount, '4.5');
  assert.equal(text.includes('outro/modelo'), false);
  assert.equal(text.includes('hash'), false);
  assert.equal(text.includes(rawKey), false);

  const other = await (await fetch(`${base}/admin/client-summary?keyId=k-other`, { headers: adminHeaders })).json();
  assert.equal(other.account.name, 'Outro Cliente');
  assert.equal(other.recent[0].model, 'outro/modelo');
  assert.equal(other.wallet.balance, '-99');
  assert.equal(other.wallet.negative, true);

  const period = `from=${encodeURIComponent(daysAgo(7))}&to=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}`;
  assert.equal((await fetch(`${base}/admin/client-stats?keyId=k-client`)).status, 401);
  assert.equal((await fetch(`${base}/admin/client-stats?keyId=k-client`, { headers: { authorization: `Bearer ${rawKey}` } })).status, 401);

  const statsResponse = await fetch(`${base}/admin/client-stats?keyId=k-client&${period}`, { headers: adminHeaders });
  assert.equal(statsResponse.status, 200);
  const statsText = await statsResponse.text();
  const stats = JSON.parse(statsText);
  assert.equal(stats.account.name, 'Alan Diniz');
  assert.equal(stats.totals.requests, 1);
  assert.equal(stats.totals.tokens, 200);
  assert.deepEqual(stats.totals.spend, [{ currency: 'USD', amount: '4.5' }]);
  assert.equal(stats.byModel[0].model, 'anubis/mistral');
  assert.equal(stats.byModel[0].requests, 1);
  assert.equal(stats.byProvider[0].provider, 'fornecedor');
  assert.equal(statsText.includes('outro/modelo'), false);
  assert.equal(statsText.includes('hash'), false);
  assert.equal(statsText.includes(rawKey), false);

  const invalidPeriod = await fetch(`${base}/admin/client-stats?keyId=k-client&from=24%2F11%2F2026`, { headers: adminHeaders });
  assert.equal(invalidPeriod.status, 400);
  assert.match((await invalidPeriod.json()).error, /ISO UTC/);
  const invalidKey = await fetch(`${base}/admin/client-stats?keyId=inexistente`, { headers: adminHeaders });
  assert.equal(invalidKey.status, 400);

  const otherStats = await (await fetch(`${base}/admin/client-stats?keyId=k-other&${period}`, { headers: adminHeaders })).json();
  assert.equal(otherStats.account.name, 'Outro Cliente');
  assert.equal(otherStats.byModel[0].model, 'outro/modelo');
  assert.deepEqual(otherStats.totals.spend, [{ currency: 'USD', amount: '99' }]);
});

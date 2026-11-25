import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAXROUTER_PRICING_PAGE, MAXROUTER_PRICING_URL, parseMaxRouterPrices } from '../src/maxrouter-pricing.js';

test('parser congela apenas preços públicos explícitos e ignora descontos condicionais', () => {
  const capturedAt = '2026-11-25T03:00:00.000Z';
  const prices = parseMaxRouterPrices({ data: [
    { slug: 'barato/modelo', status: 'READY', inputPrice: '0.140000', outputPrice: '0.280000' },
    { slug: 'com_desconto/modelo', status: 'READY', inputPrice: '0.100000', outputPrice: '0.500000', conditionalDiscount: { multiplier: 0.5, validUntil: '2026-11-25T03:05:22Z' } },
    { slug: 'sem_preco/modelo', status: 'READY' },
    { slug: 'indisponivel/modelo', status: 'COMING_SOON', inputPrice: '1', outputPrice: '2' },
    { id: 'sem_slug', status: 'READY', inputPrice: '1', outputPrice: '2' },
    { slug: 'invalido/modelo', status: 'READY', inputPrice: '-1', outputPrice: '2' },
    { slug: 'numerico/modelo', status: 'READY', inputPrice: 0.1, outputPrice: 0.2 },
    { slug: 'duplicado/modelo', status: 'READY', inputPrice: '1', outputPrice: '2' },
    { slug: 'duplicado/modelo', status: 'READY', inputPrice: '3', outputPrice: '4' },
  ] }, capturedAt);
  assert.deepEqual(prices.get('barato/modelo'), {
    currency: 'USD', unit: 'per_1m_tokens', tier: 'standard_context', input: '0.140000', output: '0.280000',
    source: MAXROUTER_PRICING_PAGE, sourceData: MAXROUTER_PRICING_URL, capturedAt,
  });
  assert.equal(prices.get('com_desconto/modelo').input, '0.100000');
  assert.equal(prices.has('sem_preco/modelo'), false);
  assert.equal(prices.has('indisponivel/modelo'), false);
  assert.equal(prices.has('sem_slug'), false);
  assert.equal(prices.has('invalido/modelo'), false);
  assert.equal(prices.has('numerico/modelo'), false);
  assert.equal(prices.get('duplicado/modelo').input, '3');
});

test('refresh do MaxRouter mescla preço público sem expor credencial e permite ativar somente modelos com preço', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-maxrouter-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const providerKey = 'upstream-maxrouter-1234567890';
  let publicPricesAvailable = true;
  const mock = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v1/models')) {
      if (!publicPricesAvailable) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([
        { slug: 'priced/model', status: 'READY', inputPrice: '0.140000', outputPrice: '0.280000' },
        { slug: 'discount/model', status: 'READY', inputPrice: '0.100000', outputPrice: '0.500000', conditionalDiscount: { multiplier: 0.5 } },
        { slug: 'future/model', status: 'COMING_SOON', inputPrice: '1', outputPrice: '2' },
      ]));
    }
    if (req.headers.authorization !== `Bearer ${providerKey}`) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [
      { id: 'priced/model', display_name: 'Modelo com preço', modality: 'chat', pricing: { currency: 'BRL', input: '999', output: '999' } },
      { id: 'unpriced/model', display_name: 'Modelo sem preço', modality: 'chat' },
    ] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], { env: {
    ...process.env, NODE_ENV: 'test', PORT: String(port), TEST_UPSTREAM_URL: `http://127.0.0.1:${mock.address().port}`,
    ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'cd'.repeat(32),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => mock.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`server exited ${code}`))); });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
  const created = await fetch(`${base}/admin/connections`, { method: 'POST', headers, body: JSON.stringify({ provider: 'maxrouter', name: 'Principal', key: providerKey }) });
  const createdBody = await created.json();
  assert.equal(created.status, 201, createdBody.error || JSON.stringify(createdBody));
  const connection = createdBody.connection;
  const catalog = await (await fetch(`${base}/admin/connections/${connection.id}/models`, { headers })).json();
  const priced = catalog.models.find(model => model.id === 'priced/model');
  const unpriced = catalog.models.find(model => model.id === 'unpriced/model');
  assert.equal(priced.pricing.input, '0.140000');
  assert.equal(priced.pricing.output, '0.280000');
  assert.equal(priced.pricing.currency, 'USD');
  assert.equal(priced.billingType, 'token');
  assert.equal(priced.priceSource.page, MAXROUTER_PRICING_PAGE);
  assert.match(priced.priceSource.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(priced.pricing.sourceData, MAXROUTER_PRICING_URL);
  assert.equal(priced.pricing.currency, 'USD');
  assert.equal(unpriced.pricing, null);
  assert.equal(connection.priceSource.count, 1);
  assert.equal(connection.priceSource.stale, false);
  assert.equal((await fetch(`${base}/admin/connections/${connection.id}/models`, { method: 'POST', headers, body: JSON.stringify({ id: 'priced/model', enabled: true }) })).status, 200);
  const persisted = await readFile(path.join(dir, 'data', 'credentials.json'), 'utf8');
  assert.equal(persisted.includes(providerKey), false);
  assert.equal(persisted.includes('0.140000'), true);

  publicPricesAvailable = false;
  const refresh = await fetch(`${base}/admin/connections/${connection.id}/refresh`, { method: 'POST', headers, body: '{}' });
  const refreshBody = await refresh.json();
  assert.equal(refresh.status, 200, refreshBody.error || JSON.stringify(refreshBody));
  assert.equal(refreshBody.connection.priceSource.stale, true);
  const staleCatalog = await (await fetch(`${base}/admin/connections/${connection.id}/models`, { headers })).json();
  const stalePriced = staleCatalog.models.find(model => model.id === 'priced/model');
  assert.equal(stalePriced.pricing.input, '0.140000');
  assert.equal(stalePriced.priceStale, true);
  assert.equal(stalePriced.priceSource.stale, true);
});

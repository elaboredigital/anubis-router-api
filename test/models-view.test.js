import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('página de modelos oferece visualização em cards e lista com os mesmos controles', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-models-view-'));
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../public', path.join(dir, 'public'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), ANUBIS_ADMIN_KEY: 'admin-key-1234567890123', ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', code => reject(new Error(`servidor encerrou com ${code}`)));
  });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const page = await fetch(`${base}/models`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-page="models"/);
  assert.match(html, /aria-label="Visualização do catálogo"/);
  assert.match(html, /data-view="cards"[^>]*aria-pressed="true"/);
  assert.match(html, /data-view="list"[^>]*aria-pressed="false"/);
  assert.match(html, /id="catalog-offer"/);
  for (const value of ['supplier-free', 'supplier-paid', 'offered-free', 'sale-priced', 'supplier-free-unpriced', 'unpriced']) assert.match(html, new RegExp(`value="${value}"`));
  assert.match(html, /id="catalog-offer-summary"/);

  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /anubis-catalog-view/);
  assert.match(script, /catalogView === 'list'/);
  assert.match(script, /className = 'model-card'/);
  assert.match(script, /className = 'model-row'/);
  assert.match(script, /buildPriceForm\(model, info\.providerId, info\.rule\)/);
  assert.match(script, /buildManualPricing\(model, info\.providerId, info\.manual\)/);
  assert.match(script, /offerMatches\(info, offerFilter\)/);
  assert.match(script, /buildOfferActions\(model, info, manualDetails\)/);
  assert.match(script, /Oferecer grátis/);
  assert.match(script, /Cobrar por uso/);
  assert.match(script, /scope: 'manual_model'/);
  assert.match(script, /supplierFree/);

  const css = await (await fetch(`${base}/style.css`)).text();
  assert.match(css, /\.view-toggle\{/);
  assert.match(css, /\.model-list\{/);
  assert.match(css, /\.model-row\{/);
  const extras = await (await fetch(`${base}/panel-extras.css`)).text();
  assert.match(extras, /\.model-offer-tag\{/);
  assert.match(extras, /\.model-offer-actions\{/);
});

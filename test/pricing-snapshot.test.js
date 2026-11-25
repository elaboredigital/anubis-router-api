import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceSnapshot } from '../src/pricing.js';

test('priceSnapshot captura o custo do catalogo e ignora o preco de venda manual', () => {
  const model = { id: 'remote/tokens', billingType: 'token', planOnly: false, pricing: { currency: 'USD', input: '1', output: '2', cache_read: '0.1', cache_write: '0.4' } };
  const catalog = priceSnapshot(model, 'xkiro');
  assert.deepEqual(catalog, { billingType: 'token', currency: 'USD', request: null, input: '1', output: '2', cacheRead: '0.1', cacheWrite: '0.4', planOnly: false });

  // Cobrar por um modelo free grava preço de venda manual; o custo continua sendo o do catálogo (zero).
  const manual = [{ provider: 'xkiro', model: 'remote/tokens', price: { currency: 'BRL', basis: 'per_1m_tokens', input: '3', output: '4', cacheRead: '0.5', cacheWrite: '0.6' } }];
  assert.deepEqual(priceSnapshot(model, 'xkiro', manual), catalog);

  const freeModel = { id: 'free/model', billingType: 'token', pricing: { currency: 'USD', input: '0', output: '0' } };
  assert.equal(priceSnapshot(freeModel, 'xkiro', manual).input, '0');
  assert.equal(priceSnapshot({ id: 'x', billingType: 'token' }, 'xkiro'), null);
});

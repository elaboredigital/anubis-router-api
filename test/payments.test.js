import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeGateways, findGateway, publicGateways, parseNotification, ADAPTERS } from '../src/payments.js';

const fake = { id: 'fake', label: 'Gateway de teste', methods: ['PIX'], config: env => (env.FAKE_KEY ? { key: env.FAKE_KEY } : null) };
const adapters = { ...ADAPTERS, fake };
const payssionEnv = { PAYSSION_API_KEY: 'pk', PAYSSION_SECRET_KEY: 'sk' };

test('só gateways configurados ficam ligados, na ordem de PAYMENT_GATEWAYS', () => {
  assert.deepEqual(activeGateways({}, adapters), []);
  assert.deepEqual(publicGateways({ ...payssionEnv, FAKE_KEY: 'x' }, adapters).map(g => g.id), ['payssion', 'fake']);
  assert.deepEqual(publicGateways({ ...payssionEnv, FAKE_KEY: 'x', PAYMENT_GATEWAYS: 'fake,payssion' }, adapters).map(g => g.id), ['fake', 'payssion']);
  assert.deepEqual(publicGateways({ ...payssionEnv, FAKE_KEY: 'x', PAYMENT_GATEWAYS: 'fake' }, adapters).map(g => g.id), ['fake']);
  assert.deepEqual(publicGateways({ PAYMENT_GATEWAYS: 'fake,payssion' }, adapters), [], 'ligado sem credencial não aparece');
  assert.equal(findGateway('payssion', { ...payssionEnv, PAYMENT_GATEWAYS: 'fake' }, adapters), null);
  assert.doesNotMatch(JSON.stringify(publicGateways(payssionEnv, adapters)), /pk|sk/, 'credenciais não vão para o cliente');
});

test('notificação chega em JSON ou formulário', () => {
  assert.deepEqual(parseNotification('{"a":1}', 'application/json; charset=utf-8'), { a: 1 });
  assert.deepEqual(parseNotification('a=1&b=x', 'application/x-www-form-urlencoded'), { a: '1', b: 'x' });
});

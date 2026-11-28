import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profitRule, comparableValue } from '../src/profit-rule.js';

const token = (input, output) => ({ billingType: 'token', currency: 'USD', input, output });

test('lucro fica entre 30% e 80% sobre o custo', () => {
  assert.deepEqual(profitRule(token('1', '2'), null, '5'), { multiplier: '1.8', active: true, profitPercent: 80 });
  assert.equal(profitRule(token('1', '2'), null, '1.1').multiplier, '1.3');
  assert.equal(profitRule(token('1', '2'), null, null).multiplier, '1.8');
  assert.equal(profitRule(token('1', '2'), null, '1.5').multiplier, '1.5');
});

test('venda nunca passa do original e abaixo de 30% o modelo não ativa', () => {
  const capped = profitRule(token('1', '2'), token('1.5', '3'), '1.8');
  assert.equal(capped.multiplier, '1.5'); assert.equal(capped.active, true);
  const blocked = profitRule(token('10', '50'), token('10', '50'), '1.8');
  assert.equal(blocked.active, false);
  assert.equal(profitRule(token('1', '1'), token('1.29', '1.29'), '1.8').active, false);
});

test('custo por chamada compara com a tabela por token numa chamada típica', () => {
  assert.ok(Math.abs(comparableValue(token('4', '20'), 'request') - 0.15) < 1e-12);
  const rule = profitRule({ billingType: 'request', currency: 'USD', request: '0.02' }, token('4', '20'), '5');
  assert.equal(rule.multiplier, '1.8'); assert.equal(rule.active, true);
});

test('modelo grátis continua ativo', () => {
  assert.equal(profitRule(token('0', '0'), token('1', '2'), '1.8').active, true);
});

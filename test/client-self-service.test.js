import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FREE_PLAN } from '../src/plans.js';
import { MAX_KEYS_PER_OWNER, rootKeyId, ownerKeys, safeKey, buildSelfServiceSummary, validateCreateKey, validatePlanChange, validateRevoke } from '../src/client-self-service.js';

const plans = [
  { ...DEFAULT_FREE_PLAN },
  { id: 'pro', name: 'Pro', kind: 'paid', monthlyRequests: 1000, monthlyTokens: 10000000, models: ['m1'], active: true, selfService: false },
  { id: 'publico', name: 'Público', kind: 'free', monthlyRequests: 50, monthlyTokens: 1000, models: ['m1'], active: true, selfService: true },
];
const owner = { id: 'k1', name: 'Principal', prefix: 'anubis_abc12345', hash: 'hash-secreta', active: true, createdAt: '2026-11-01T00:00:00.000Z', planId: 'free' };
const child = { id: 'k2', name: 'Derivada', prefix: 'anubis_def67890', hash: 'outra-hash', active: true, createdAt: '2026-11-02T00:00:00.000Z', planId: 'publico', parentId: 'k1' };
const stranger = { id: 'k9', name: 'Outra conta', prefix: 'anubis_zzzz', hash: 'terceiros', active: true, createdAt: '2026-11-01T00:00:00.000Z', planId: 'free' };
const keys = [owner, child, stranger];

test('grupo da chave isola dados e nunca devolve hash ou chave completa', () => {
  assert.equal(rootKeyId(owner), 'k1');
  assert.equal(rootKeyId(child), 'k1');
  assert.deepEqual(ownerKeys(keys, child).map(item => item.id), ['k1', 'k2']);
  const safe = safeKey(child, plans, 'k1');
  assert.equal(safe.label, 'anubis_def67890••••••••');
  assert.equal(safe.role, 'derivada');
  assert.equal(JSON.stringify(safe).includes('hash'), false);
  assert.equal(JSON.stringify(safe).includes('outra-hash'), false);
});

test('resumo mostra somente planos liberados e chaves do próprio grupo', () => {
  const report = buildSelfServiceSummary({ key: child, keys, plans, now: '2026-11-24T12:00:00.000Z' });
  assert.equal(report.account.isRoot, false);
  assert.deepEqual(report.keys.map(item => item.id), ['k1', 'k2']);
  assert.deepEqual(report.availablePlans.map(item => item.id), ['free', 'publico']);
  assert.equal(report.availablePlans.some(item => item.id === 'pro'), false);
  assert.equal(report.selfService, true);
  const text = JSON.stringify(report);
  for (const needle of ['hash-secreta', 'outra-hash', 'terceiros', '"secret"', '"hash"']) assert.equal(text.includes(needle), false, needle);
});

test('criação respeita limite, plano liberado e plano da chave principal', () => {
  assert.equal(validateCreateKey({ name: 'Nova' }, keys, plans, owner), null);
  assert.match(validateCreateKey({ name: '' }, keys, plans, owner), /nome/);
  assert.match(validateCreateKey({ name: 'Nova', planId: 'pro' }, keys, plans, owner), /Plano indisponível/);
  const many = Array.from({ length: MAX_KEYS_PER_OWNER }, (_, index) => ({ ...child, id: `k${index}` }));
  assert.match(validateCreateKey({ name: 'Nova' }, many, plans, owner), /Limite local/);
  const rootWithoutPlan = { ...owner, planId: null };
  assert.match(validateCreateKey({ name: 'Nova' }, [], plans, rootWithoutPlan), /precisa de um plano/);
  assert.equal(validateCreateKey({ name: 'Nova', planId: 'publico' }, [], plans, rootWithoutPlan), null);
});

test('troca de plano e revogação não permitem escalada nem tocar em outra conta', () => {
  assert.equal(validatePlanChange({ id: 'k2', planId: 'publico' }, [owner, child], plans), null);
  assert.match(validatePlanChange({ id: 'k2', planId: null }, [owner, child], plans), /Escolha um plano/);
  assert.match(validatePlanChange({ id: 'k2', planId: 'pro' }, [owner, child], plans), /Plano indisponível/);
  assert.match(validatePlanChange({ id: 'k9', planId: 'publico' }, [owner, child], plans), /seu grupo/);
  assert.equal(validateRevoke({ id: 'k2' }, [owner, child]), null);
  assert.match(validateRevoke({ id: 'k1' }, [owner, child]), /chave principal/);
  assert.match(validateRevoke({ id: 'k9' }, [owner, child]), /seu grupo/);
});

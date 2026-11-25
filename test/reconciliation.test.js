import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePeriod, filterByPeriod, pendingReason, listPending,
  normalizeReconciliation, validateReconciliation, applyReconciliation,
} from '../src/reconciliation.js';

const record = (overrides = {}) => ({
  id: 'attempt-1', requestId: 'req-1', attempt: 1, destinationId: 'dest-1',
  provider: 'xkiro', connectionId: 'conn-1', clientKeyId: 'key-1', planId: null,
  publicModel: 'anubis/teste', upstreamModel: 'remote/model', endpoint: '/v1/chat/completions',
  startedAt: '2026-11-24T10:00:00.000Z', finishedAt: '2026-11-24T10:00:01.000Z',
  status: 'upstream_unknown', costSnapshot: { request: '0.02', currency: 'USD' },
  usage: { inputTokens: 12 }, secret: 'nunca-sair-daqui', prompt: 'pergunta privada',
  ...overrides,
});

test('parsePeriod valida ISO UTC e rejeita intervalos invertidos', () => {
  assert.deepEqual(parsePeriod({}), { from: null, to: null, error: null });
  assert.deepEqual(parsePeriod({ from: '2026-11-24T00:00:00.000Z', to: '' }), { from: '2026-11-24T00:00:00.000Z', to: null, error: null });
  assert.match(parsePeriod({ from: 'amanhã' }).error, /ISO/i);
  assert.match(parsePeriod({ from: '2026-11-24T12:00:00.000Z', to: '2026-11-24T10:00:00.000Z' }).error, /anterior/i);
});

test('filterByPeriod usa início inclusive e fim exclusivo, sem inventar data ausente', () => {
  const records = [
    record({ id: 'a', startedAt: '2026-11-24T09:59:59.999Z' }),
    record({ id: 'b', startedAt: '2026-11-24T10:00:00.000Z' }),
    record({ id: 'c', startedAt: '2026-11-24T10:59:59.999Z' }),
    record({ id: 'd', startedAt: '2026-11-24T11:00:00.000Z' }),
    record({ id: 'e', startedAt: null, finishedAt: null }),
  ];
  const period = { from: '2026-11-24T10:00:00.000Z', to: '2026-11-24T11:00:00.000Z' };
  assert.deepEqual(filterByPeriod(records, period).map(item => item.id), ['b', 'c']);
  assert.equal(filterByPeriod(records, {}).length, 5);
});

test('pendingReason separa falhas sem desfecho de falhas conhecidas', () => {
  assert.equal(pendingReason(record({ status: 'pending' })), 'sem_desfecho');
  assert.equal(pendingReason(record({ status: 'upstream_unknown' })), 'falha_transporte');
  assert.equal(pendingReason(record({ status: 'upstream_error' })), 'erro_sem_status');
  assert.equal(pendingReason(record({ status: 'upstream_error', httpStatus: 429 })), null);
  assert.equal(pendingReason(record({ status: 'completed' })), null);
  assert.equal(pendingReason(record({ status: 'cancelled' })), null);
});

test('listPending expõe apenas campos seguros e separa resolvidos por padrão', () => {
  const records = [
    record({ id: 'a', status: 'pending', requestId: 'req-a' }),
    record({ id: 'b', status: 'upstream_error', httpStatus: 500 }),
    record({ id: 'c', status: 'upstream_unknown', requestId: 'req-c' }),
  ];
  const annotations = [{ recordId: 'c', outcome: 'no_cost', at: '2026-11-24T11:00:00.000Z' }];
  const report = listPending(records, annotations, {}, {});
  assert.deepEqual(report.items.map(item => item.id), ['a']);
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.unresolved, 1);
  assert.equal(report.summary.resolved, 1);
  assert.equal(report.summary.requests, 2);
  assert.equal(report.summary.byReason.sem_desfecho, 1);
  const all = listPending(records, annotations, {}, { includeResolved: true });
  assert.deepEqual(all.items.map(item => item.id), ['a', 'c']);
  const text = JSON.stringify(all);
  assert.equal(text.includes('nunca-sair-daqui'), false);
  assert.equal(text.includes('pergunta privada'), false);
  assert.equal(all.items[1].reason, 'falha_transporte');
  assert.equal(all.items[1].reconciliation.outcome, 'no_cost');
  assert.deepEqual(all.items[0].usage, { inputTokens: 12 });
});

test('validateReconciliation exige registro pendente e rejeita duplicidade', () => {
  const records = [record({ status: 'pending' })];
  assert.deepEqual(normalizeReconciliation({ recordId: 'attempt-1', outcome: 'no_cost', note: '  sem cobrança  ' }), { recordId: 'attempt-1', outcome: 'no_cost', note: 'sem cobrança' });
  assert.equal(validateReconciliation({ recordId: 'attempt-1', outcome: 'no_cost' }, records, []), null);
  assert.match(validateReconciliation({ recordId: 'outro', outcome: 'no_cost' }, records, []), /encontrado/i);
  assert.match(validateReconciliation({ recordId: 'attempt-1', outcome: 'pagar' }, records, []), /desfecho/i);
  assert.match(validateReconciliation({ recordId: 'attempt-1', outcome: 'no_cost', note: 'x'.repeat(241) }, records, []), /nota/i);
  assert.match(validateReconciliation({ recordId: 'attempt-1', outcome: 'no_cost' }, records, [{ recordId: 'attempt-1' }]), /já foi conciliado/i);
});

test('applyReconciliation anota sem alterar status, custo ou venda e gera auditoria sem segredos', () => {
  const original = record({ status: 'pending' });
  const result = applyReconciliation({ recordId: 'attempt-1', outcome: 'no_cost', note: 'fornecedor confirmou' }, [original], [], '2026-11-24T11:00:00.000Z');
  assert.equal(result.record.status, 'pending');
  assert.deepEqual(result.record.costSnapshot, original.costSnapshot);
  assert.deepEqual(result.record.saleSnapshot, undefined);
  assert.deepEqual(result.annotation, { id: 'rec-attempt-1', recordId: 'attempt-1', requestId: 'req-1', outcome: 'no_cost', note: 'fornecedor confirmou', at: '2026-11-24T11:00:00.000Z' });
  assert.equal(result.event.action, 'usage_reconcile');
  assert.equal(result.event.target, 'req-1');
  assert.equal(result.event.detail, 'fornecedor confirmou');
  assert.equal(result.event.after.outcome, 'no_cost');
  assert.equal(JSON.stringify(result.event).includes('nunca-sair-daqui'), false);
  assert.equal(JSON.stringify(result.event).includes('pergunta privada'), false);
});

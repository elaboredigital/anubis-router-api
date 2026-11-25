// Conciliação local de tentativas sem desfecho conhecido. Nenhuma função daqui infere custo,
// altera status de uso, lança no ledger ou desconta saldo: apenas classifica e registra conferência.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REASONS = ['sem_desfecho', 'falha_transporte', 'erro_sem_status'];
const AUDIT_FIELDS = ['id', 'requestId', 'attempt', 'destinationId', 'provider', 'connectionId', 'publicModel', 'upstreamModel', 'status', 'reason', 'outcome', 'at'];
const ITEM_FIELDS = ['id', 'requestId', 'attempt', 'destinationId', 'provider', 'connectionId', 'clientKeyId', 'planId', 'publicModel', 'upstreamModel', 'endpoint', 'startedAt', 'finishedAt', 'httpStatus', 'status', 'costSnapshot', 'saleSnapshot'];
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'];

function pick(source, fields) {
  if (!source || typeof source !== 'object') return {};
  return Object.fromEntries(fields.filter(field => source[field] !== undefined && source[field] !== null).map(field => [field, source[field]]));
}

export function parsePeriod(params = {}) {
  const read = key => params[key] === undefined || params[key] === null || params[key] === '' ? null : params[key];
  const from = read('from'); const to = read('to');
  for (const value of [from, to]) {
    if (value !== null && (typeof value !== 'string' || !ISO_UTC.test(value) || Number.isNaN(Date.parse(value)))) return { from, to, error: 'Período inválido: use ISO UTC (2026-11-24T00:00:00.000Z).' };
  }
  if (from && to && Date.parse(from) >= Date.parse(to)) return { from, to, error: 'Período inválido: o início deve ser anterior ao fim.' };
  return { from, to, error: null };
}

export function filterByPeriod(records, period = {}) {
  const items = Array.isArray(records) ? records : [];
  if (!period.from && !period.to) return items;
  const start = period.from ? Date.parse(period.from) : null;
  const end = period.to ? Date.parse(period.to) : null;
  return items.filter(item => {
    const at = Date.parse(item?.startedAt || item?.finishedAt);
    if (!Number.isFinite(at)) return false;
    return (start === null || at >= start) && (end === null || at < end);
  });
}

export function pendingReason(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.status === 'pending') return 'sem_desfecho';
  if (record.status === 'upstream_unknown') return 'falha_transporte';
  if (record.status === 'upstream_error' && !Number.isSafeInteger(record.httpStatus)) return 'erro_sem_status';
  return null;
}

function buildPendingItem(record, annotation, now) {
  const reason = pendingReason(record);
  const item = { ...pick(record, ITEM_FIELDS), reason, usage: pick(record?.usage, USAGE_FIELDS) };
  if (annotation) item.reconciliation = { outcome: annotation.outcome, note: annotation.note || null, at: annotation.at || null };
  else item.reconciliation = null;
  void now;
  return item;
}

export function listPending(records, annotations = [], period = {}, options = {}) {
  const byRecord = new Map((Array.isArray(annotations) ? annotations : []).filter(item => item?.recordId && item?.outcome === 'no_cost').map(item => [item.recordId, item]));
  const inPeriod = filterByPeriod(records, period);
  const items = [];
  const byReason = Object.fromEntries(REASONS.map(reason => [reason, 0]));
  const requests = new Set(); let resolved = 0; let unresolved = 0;
  for (const record of inPeriod) {
    const reason = pendingReason(record);
    if (!reason) continue;
    const annotation = byRecord.get(record.id) || null;
    if (annotation) resolved++; else unresolved++;
    byReason[reason]++;
    requests.add(record.requestId || record.id);
    if (!annotation || options.includeResolved) items.push(buildPendingItem(record, annotation));
  }
  return { items, summary: { total: resolved + unresolved, resolved, unresolved, requests: requests.size, byReason }, period: { from: period.from || null, to: period.to || null }, scope: 'last_10000_requests' };
}

export function normalizeReconciliation(data = {}) {
  const text = value => typeof value === 'string' ? value.trim() : null;
  return { recordId: text(data.recordId) || null, outcome: text(data.outcome) || null, note: text(data.note) || null };
}

export function validateReconciliation(data, records, annotations = []) {
  const value = normalizeReconciliation(data);
  if (!value.recordId) return 'Registro inválido.';
  if (value.outcome !== 'no_cost') return 'Desfecho inválido: apenas "sem custo" pode ser confirmado localmente.';
  if (value.note && value.note.length > 240) return 'Nota deve ter no máximo 240 caracteres.';
  const record = (Array.isArray(records) ? records : []).find(item => item?.id === value.recordId);
  if (!record) return 'Registro de uso não encontrado.';
  if (!pendingReason(record)) return 'Este registro não está pendente de conciliação.';
  if ((Array.isArray(annotations) ? annotations : []).some(item => item?.recordId === value.recordId)) return 'Este registro já foi conciliado.';
  return null;
}

export function buildReconciliationAudit(action, target, before, after, detail = null, at = new Date().toISOString()) {
  return { at, action, target, before: pick(before, AUDIT_FIELDS), after: pick(after, AUDIT_FIELDS), detail };
}

export function applyReconciliation(data, records, annotations = [], at = new Date().toISOString()) {
  const value = normalizeReconciliation(data);
  const record = records.find(item => item.id === value.recordId);
  const reason = pendingReason(record);
  const annotation = { id: `rec-${record.id}`, recordId: record.id, requestId: record.requestId || null, outcome: value.outcome, note: value.note, at };
  const before = { id: record.id, requestId: record.requestId || null, attempt: record.attempt, destinationId: record.destinationId, provider: record.provider, connectionId: record.connectionId, publicModel: record.publicModel, upstreamModel: record.upstreamModel, status: record.status, reason };
  const event = buildReconciliationAudit('usage_reconcile', record.requestId || record.id, before, { ...before, outcome: value.outcome, at }, value.note, at);
  return { annotation, event, record: { ...record, reconciliation: { outcome: value.outcome, note: value.note, at } } };
}

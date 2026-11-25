// Política local de roteamento: o padrão distribui entre destinos de mesma prioridade e troca de rota em erro HTTP.
// Mudanças de estratégia, peso, limite de tentativas, timeout, failover e resfriamento são opcionais e auditáveis.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RETRYABLE_STATUSES = new Set([401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504]);
const AUDIT_FIELDS = ['destinationId', 'id', 'provider', 'connectionId', 'upstreamModel', 'priority', 'weight', 'enabled', 'cooldownUntil'];

// Padrão: distribui entre destinos de mesma prioridade e troca de rota em qualquer erro HTTP.
export const DEFAULT_ROUTING_POLICY = Object.freeze({
  strategy: 'round_robin',
  maxAttempts: null,
  retryStatuses: [429, 500, 502, 503, 504],
  timeoutMs: null,
  cooldownMs: 0,
  failoverOnError: true,
});

function numberOrRaw(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return value;
}

export function normalizeRoutingPolicy(data = {}) {
  const statuses = data.retryStatuses === undefined ? DEFAULT_ROUTING_POLICY.retryStatuses
    : Array.isArray(data.retryStatuses) ? data.retryStatuses : String(data.retryStatuses).split(',');
  return {
    strategy: data.strategy === undefined || data.strategy === null || data.strategy === '' ? DEFAULT_ROUTING_POLICY.strategy : data.strategy,
    maxAttempts: numberOrRaw(data.maxAttempts, null),
    retryStatuses: statuses.map(item => numberOrRaw(typeof item === 'string' ? item.trim() : item, NaN)).filter(item => item !== ''),
    timeoutMs: numberOrRaw(data.timeoutMs, null),
    cooldownMs: numberOrRaw(data.cooldownMs, 0),
    failoverOnError: data.failoverOnError === undefined || data.failoverOnError === null || data.failoverOnError === '' ? DEFAULT_ROUTING_POLICY.failoverOnError : data.failoverOnError === true || data.failoverOnError === 'true',
  };
}

export function validateRoutingPolicy(policy) {
  if (!policy || !['priority', 'weighted', 'round_robin'].includes(policy.strategy)) return 'Estratégia de roteamento inválida.';
  if (policy.maxAttempts !== null && (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10)) return 'Limite de tentativas deve estar entre 1 e 10.';
  if (!Array.isArray(policy.retryStatuses) || policy.retryStatuses.some(status => !RETRYABLE_STATUSES.has(status))) return 'Status de retentativa inválido.';
  if (policy.timeoutMs !== null && (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs < 100 || policy.timeoutMs > 120000)) return 'Timeout deve estar entre 100 e 120000 ms.';
  if (!Number.isSafeInteger(policy.cooldownMs) || policy.cooldownMs < 0 || policy.cooldownMs > 600000) return 'Resfriamento deve estar entre 0 e 600000 ms.';
  if (typeof policy.failoverOnError !== 'boolean') return 'Failover em erro inválido.';
  return null;
}

export function normalizeRoutingFields(data = {}) {
  const raw = data.cooldownUntil;
  return {
    weight: numberOrRaw(data.weight, 1),
    cooldownUntil: raw === '' || raw === null || raw === undefined ? null : raw,
  };
}

export function validateRoutingFields(fields) {
  if (!Number.isSafeInteger(fields?.weight) || fields.weight < 1 || fields.weight > 1000) return 'Peso deve estar entre 1 e 1000.';
  const until = fields.cooldownUntil;
  if (until !== null && (typeof until !== 'string' || !ISO_DATE.test(until) || Number.isNaN(Date.parse(until)))) return 'Resfriamento inválido.';
  return null;
}

function seedFrom(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) || 0x9e3779b9;
}

function randomFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return ((state >>> 0) + 1) / 4294967297;
  };
}

/** Ordena por prioridade; dentro de cada nível aplica rodízio, peso ou mantém a ordem cadastrada. */
export function orderedCandidates(candidates, policy = DEFAULT_ROUTING_POLICY, seed = '') {
  const indexed = (Array.isArray(candidates) ? candidates : []).map((item, index) => ({ item, index }));
  indexed.sort((a, b) => (a.item.priority ?? 100) - (b.item.priority ?? 100) || a.index - b.index);
  const groups = [];
  for (const entry of indexed) {
    const priority = entry.item.priority ?? 100;
    const current = groups.at(-1);
    if (current && current.priority === priority) current.items.push(entry);
    else groups.push({ priority, items: [entry] });
  }
  if (policy?.strategy === 'priority') return groups.flatMap(group => group.items.map(entry => entry.item));
  if (policy?.strategy === 'round_robin') {
    const cursor = Number.isSafeInteger(seed) ? seed : seedFrom(seed);
    return groups.flatMap(group => {
      const offset = group.items.length > 1 ? ((cursor % group.items.length) + group.items.length) % group.items.length : 0;
      return [...group.items.slice(offset), ...group.items.slice(0, offset)].map(entry => entry.item);
    });
  }
  const next = randomFrom(seedFrom(seed));
  return groups.flatMap(group => {
    const weighted = group.items.map(entry => {
      const weight = Number.isSafeInteger(entry.item.weight) && entry.item.weight > 0 ? entry.item.weight : 1;
      return { ...entry, score: Math.pow(next(), 1 / weight) };
    });
    weighted.sort((a, b) => b.score - a.score || a.index - b.index);
    return weighted.map(entry => entry.item);
  });
}

export function nextCursor(policy, seed, attempts = 0) {
  if (policy?.strategy !== 'round_robin') return seed;
  const current = Number.isSafeInteger(seed) ? seed : seedFrom(seed);
  return current + Math.max(1, attempts);
}

export function shouldRetry(policy, status, attemptsMade, total) {
  if (!Number.isSafeInteger(status) || status < 400 || status > 599) return false;
  if (attemptsMade >= total) return false;
  if (attemptsMade >= (policy.maxAttempts ?? total)) return false;
  if (Array.isArray(policy?.retryStatuses) && policy.retryStatuses.includes(status)) return true;
  return policy?.failoverOnError === true && RETRYABLE_STATUSES.has(status);
}

export function resolveTimeout(policy, fallback) {
  const value = policy?.timeoutMs;
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function isCoolingDown(route, now = Date.now()) {
  const until = Date.parse(route?.cooldownUntil);
  return Number.isFinite(until) && until > now;
}

export function buildRouteAudit(action, target, before, after, detail = null, at = new Date().toISOString()) {
  const publicRoute = value => {
    if (Array.isArray(value)) return value.map(publicRoute);
    if (!value || typeof value !== 'object') return value ?? null;
    return Object.fromEntries(AUDIT_FIELDS.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
  };
  return { at, action, target, before: publicRoute(before), after: publicRoute(after), detail };
}

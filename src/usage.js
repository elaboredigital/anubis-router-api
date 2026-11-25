import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import path from 'node:path';

// Somente metadados e contadores são persistidos; prompts, respostas e credenciais não são salvos.
export const DEFAULT_USAGE_RETENTION = Object.freeze({ retentionHours: 24 });
export function normalizeUsageRetention(data) {
  if (data === undefined) return { ...DEFAULT_USAGE_RETENTION };
  if (data === null) return { retentionHours: null };
  const raw = typeof data === 'object' ? data?.retentionHours : data;
  if (raw === null || raw === undefined || raw === '') return { retentionHours: null };
  const hours = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return { retentionHours: Number.isSafeInteger(hours) ? hours : NaN };
}
export function validateUsageRetention(config) {
  const hours = config?.retentionHours;
  if (hours === null) return null;
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 8760) return 'Retenção deve ficar entre 1 e 8760 horas, ou vazia para desativar a limpeza.';
  return null;
}
function cutoffFor(retentionHours, now) {
  if (retentionHours === null) return null;
  const time = Date.parse(now);
  return Number.isFinite(time) ? new Date(time - retentionHours * 3600000).toISOString() : null;
}
const byteCount = value => Number.isSafeInteger(value) && value > 0 ? value : 0;

export async function openUsageStore(root, databaseUrl = process.env.DATABASE_URL) {
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    await pool.query('CREATE TABLE IF NOT EXISTS anubis_usage (id UUID PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL, record JSONB NOT NULL)');
    await pool.query('CREATE INDEX IF NOT EXISTS anubis_usage_started_idx ON anubis_usage(started_at DESC)');
    return {
      async write(record) { await pool.query('INSERT INTO anubis_usage (id, started_at, record) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record', [record.id, record.startedAt, JSON.stringify(record)]); },
      async list() { const { rows } = await pool.query('SELECT record FROM anubis_usage ORDER BY started_at DESC LIMIT 10000'); return rows.map(r => r.record); },
      async prune(retentionHours, now = new Date()) {
        const cutoff = cutoffFor(retentionHours, now);
        if (!cutoff) return 0;
        const result = await pool.query('DELETE FROM anubis_usage WHERE started_at < $1', [cutoff]);
        return result.rowCount || 0;
      },
      async size() {
        const { rows } = await pool.query('SELECT pg_total_relation_size($1::regclass)::bigint AS bytes', ['anubis_usage']);
        const value = Number(rows?.[0]?.bytes);
        return Number.isSafeInteger(value) ? value : null;
      },
    };
  }
  const file = path.join(root, 'data', 'usage.jsonl');
  let writes = Promise.resolve();
  return {
    write(record) {
      const task = writes.then(async () => { await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 }); });
      writes = task.catch(() => {}); return task;
    },
    async list() {
      await writes; let text;
      try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const items = new Map();
      for (const line of text.split('\n')) if (line) { const item = JSON.parse(line); items.set(item.id, item); }
      return [...items.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 10000);
    },
    prune(retentionHours, now = new Date()) {
      const cutoff = cutoffFor(retentionHours, now);
      if (!cutoff) return Promise.resolve(0);
      const limit = Date.parse(cutoff);
      const task = writes.then(async () => {
        let text;
        try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
        const items = new Map();
        for (const line of text.split('\n')) if (line) { const item = JSON.parse(line); items.set(item.id, item); }
        const kept = [...items.values()].filter(item => Date.parse(item.startedAt || item.finishedAt) >= limit);
        const removed = items.size - kept.length;
        if (!removed) return 0;
        const tmp = `${file}.${randomUUID()}.tmp`;
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(tmp, kept.length ? kept.map(item => JSON.stringify(item)).join('\n') + '\n' : '', { mode: 0o600 });
        await rename(tmp, file);
        return removed;
      });
      writes = task.catch(() => {}); return task;
    },
    async size() { return null; },
  };
}

const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// APIs gratuitas e streams costumam omitir `usage`. A chamada ainda consome tokens, então
// estimamos por caracteres e marcamos a medição como estimada em vez de registrar zero.
export function estimateTokens(text) {
  return typeof text === 'string' && text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') text += part;
    else if (part && typeof part.text === 'string') text += part.text;
    else if (part && typeof part.content === 'string') text += part.content;
  }
  return text;
}
export function estimateInputTokens(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  let chars = 0; let overhead = 0;
  const addMessage = message => {
    if (!message || typeof message !== 'object') return;
    overhead += 4;
    chars += contentText(message.content).length;
    if (typeof message.reasoning_content === 'string') chars += message.reasoning_content.length;
  };
  if (Array.isArray(payload.messages)) for (const message of payload.messages) addMessage(message);
  if (Array.isArray(payload.input)) for (const item of payload.input) addMessage(item);
  else if (typeof payload.input === 'string') chars += payload.input.length;
  const system = payload.system ?? payload.instructions;
  if (typeof system === 'string') chars += system.length;
  else if (Array.isArray(system)) for (const part of system) chars += contentText(part).length;
  for (const field of ['tools', 'functions']) if (Array.isArray(payload[field])) {
    overhead += payload[field].length * 8;
    try { chars += JSON.stringify(payload[field]).length; } catch { /* campo não serializável */ }
  }
  return Math.ceil(chars / 4) + overhead;
}
function collectText(value, counters) { if (typeof value === 'string' && value) counters.outputChars += value.length; }
export function collectOutputText(payload, counters) {
  if (!payload || typeof payload !== 'object' || !counters) return;
  if (Array.isArray(payload.choices)) for (const choice of payload.choices) {
    collectText(contentText(choice?.delta?.content), counters);
    collectText(contentText(choice?.message?.content), counters);
    collectText(choice?.text, counters);
  }
  collectText(payload.completion, counters);
  if (typeof payload.delta === 'string') collectText(payload.delta, counters);
  else if (payload.delta && typeof payload.delta.text === 'string') collectText(payload.delta.text, counters);
  if (Array.isArray(payload.content)) for (const block of payload.content) collectText(block?.text, counters);
  if (Array.isArray(payload.output)) for (const item of payload.output) for (const block of item?.content || []) collectText(block?.text, counters);
}
/** Completa campos ausentes com a estimativa local sem sobrescrever medições do fornecedor. */
export function finalizeUsage(usage, { inputTokens = 0, outputChars = 0 } = {}) {
  if (!usage || typeof usage !== 'object') return usage;
  let estimated = usage.estimated === true;
  if (!Number.isSafeInteger(usage.inputTokens) && inputTokens > 0) { usage.inputTokens = inputTokens; estimated = true; }
  if (!Number.isSafeInteger(usage.outputTokens) && outputChars > 0) { usage.outputTokens = Math.ceil(outputChars / 4); estimated = true; }
  if (estimated) usage.estimated = true;
  return usage;
}
export function mergeUsage(previous, payload) {
  const usage = payload?.usage || payload?.message?.usage || payload?.response?.usage;
  if (!usage || typeof usage !== 'object') return previous;
  const next = { ...previous };
  const fields = {
    inputTokens: usage.input_tokens ?? usage.prompt_tokens,
    outputTokens: usage.output_tokens ?? usage.completion_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
  };
  for (const [key, value] of Object.entries(fields)) { const n = number(value); if (n !== null) next[key] = n; }
  return next;
}

// Inspeção limitada e transparente: cada chunk é encaminhado sem alteração nem espera por parsing.
export function usageObserver(contentType, usage, onBytes, counters = null) {
  const stream = contentType.includes('text/event-stream');
  const isJson = contentType.includes('application/json');
  const decoder = new TextDecoder(); let buffer = ''; let overflow = false;
  function parse(text) {
    try {
      const payload = JSON.parse(text);
      Object.assign(usage, mergeUsage(usage, payload));
      collectOutputText(payload, counters);
    } catch { /* evento não é JSON de uso */ }
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      if ((stream || isJson) && !overflow) {
        buffer += decoder.decode(chunk, { stream: true });
        if (stream) {
          const lines = buffer.split('\n'); buffer = lines.pop();
          for (const line of lines) if (line.startsWith('data:')) { const data = line.slice(5).trim(); if (data && data !== '[DONE]') parse(data); }
        }
        if (buffer.length > 2 * 1024 * 1024) { buffer = ''; overflow = true; }
      }
      onBytes?.(byteCount(chunk?.length));
      callback(null, chunk);
    },
    flush(callback) {
      if (!overflow && isJson && !stream) { buffer += decoder.decode(); parse(buffer); }
      if (!overflow && stream && buffer.startsWith('data:')) parse(buffer.slice(5).trim());
      callback();
    },
  });
}

export function summarizeUsage(records) {
  const groups = new Map();
  for (const record of records) {
    const key = JSON.stringify([record.provider, record.connectionId, record.upstreamModel]);
    let group = groups.get(key);
    if (!group) { group = { provider: record.provider, connectionId: record.connectionId, model: record.upstreamModel, requests: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, reportedUsage: 0, inputReported: 0, outputReported: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }; groups.set(key, group); }
    group.requests++;
    if (record.status === 'completed') group.completed++; else if (record.status === 'cancelled') group.cancelled++; else if (record.status === 'pending') group.pending++; else group.failed++;
    if (Object.keys(record.usage || {}).length) group.reportedUsage++;
    if (record.usage?.inputTokens !== undefined) group.inputReported++;
    if (record.usage?.outputTokens !== undefined) group.outputReported++;
    for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens']) group[field] += record.usage?.[field] || 0;
  }
  return { scope: 'last_10000_requests', recordCount: records.length, groups: [...groups.values()] };
}

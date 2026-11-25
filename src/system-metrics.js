// Métricas locais e agregadas: nunca coletam prompts, respostas, chaves, segredos ou variáveis de ambiente.
import { statfs, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATA_FILES = [
  'routes.json', 'credentials.json', 'api-keys.json', 'provider-accounts.json',
  'pricing-config.json', 'plans.json', 'ledger.json', 'topups.json',
  'routing-policy.json', 'route-audit.json', 'usage.jsonl',
  'usage-reconciliations.json', 'usage-reconciliation-audit.json',
  'price-history.json', 'usage-retention.json',
];
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : 0;

export function createTrafficCounters() {
  let requestBytes = 0, responseBytes = 0, upstreamRequestBytes = 0;
  let requestsWithBody = 0, streamedResponses = 0, jsonResponses = 0;
  return {
    noteRequestBytes(bytes) { requestBytes += positive(bytes); requestsWithBody++; },
    noteResponseBytes(bytes) { responseBytes += positive(bytes); jsonResponses++; },
    noteStreamedResponseBytes(bytes) { responseBytes += positive(bytes); streamedResponses++; },
    noteUpstreamRequestBytes(bytes) { upstreamRequestBytes += positive(bytes); },
    snapshot() {
      return {
        scope: 'local_process_since_start',
        requestBytesTotal: requestBytes,
        responseBytesTotal: responseBytes,
        upstreamRequestBytesTotal: upstreamRequestBytes,
        requestsWithBodyCount: requestsWithBody,
        streamedResponsesCount: streamedResponses,
        jsonResponsesCount: jsonResponses,
        httpMessagesTotal: requestsWithBody + streamedResponses + jsonResponses,
      };
    },
  };
}

async function readDisk(root) {
  try {
    const info = await statfs(root);
    const total = info.bsize * info.blocks;
    const used = info.bsize * (info.blocks - info.bfree);
    const available = info.bsize * info.bavail;
    return {
      scope: 'volume que contém data/',
      totalBytes: Number.isSafeInteger(total) ? total : null,
      usedBytes: Number.isSafeInteger(used) ? used : null,
      availableBytes: Number.isSafeInteger(available) ? available : null,
      usedPercent: info.blocks ? Math.round(used / total * 1000) / 10 : null,
    };
  } catch {
    return null;
  }
}

async function readDataFiles(root) {
  const files = [];
  for (const name of DATA_FILES) {
    try {
      const info = await stat(path.join(root, 'data', name));
      if (!info.isFile()) continue;
      files.push({ name, bytes: info.size, modifiedAt: info.mtime.toISOString() });
    } catch { /* arquivos inexistentes não entram no relatório */ }
  }
  return files.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

export async function collectSystemReport({ root, traffic, store, usageStore, retention, counts = {}, now = new Date().toISOString() } = {}) {
  const memory = process.memoryUsage();
  const dataFiles = await readDataFiles(root);
  const databaseTables = [];
  if (store?.kind === 'postgres') {
    for (const name of ['anubis_store', 'anubis_usage']) {
      const sizeOf = name === 'anubis_store' ? store.size?.bind(store) : usageStore?.size?.bind(usageStore);
      let totalBytes = null;
      try { if (sizeOf) totalBytes = await sizeOf(); } catch { /* tabela indisponível */ }
      databaseTables.push({ name, totalBytes });
    }
  }
  return {
    generatedAt: now,
    scope: 'métricas locais do processo; sem prompts, respostas, chaves ou segredos',
    process: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: Math.round(process.uptime() * 10) / 10,
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
    },
    host: {
      cpuCount: os.cpus().length,
      loadAvg1m: os.loadavg()[0] ?? null,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
    },
    traffic: traffic?.snapshot?.() || createTrafficCounters().snapshot(),
    storage: {
      mode: store?.kind === 'postgres' ? 'postgres' : 'arquivos',
      disk: await readDisk(root),
      dataFiles,
      dataFilesTotalBytes: dataFiles.reduce((sum, file) => sum + file.bytes, 0),
      database: {
        scope: store?.kind === 'postgres' ? 'pg_total_relation_size: tabela + índices + TOAST' : 'arquivos JSON/JSONL em data/',
        tables: databaseTables,
      },
    },
    retention: retention ? { retentionHours: retention.retentionHours } : null,
    gateway: {
      routesEnabled: counts.routesEnabled ?? 0,
      connectionsActive: counts.connectionsActive ?? 0,
      keysActive: counts.keysActive ?? 0,
      plansCount: counts.plansCount ?? 0,
    },
  };
}

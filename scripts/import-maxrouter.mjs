// Importa os preços públicos do MaxRouter para o catálogo autenticado e ativa as rotas com preço.
// Uso: node --env-file-if-exists=.env scripts/import-maxrouter.mjs
import { MAXROUTER_PRICING_PAGE } from '../src/maxrouter-pricing.js';

const EXPECTED_PRICED = 293;
const adminKey = process.env.ANUBIS_ADMIN_KEY;
if (!adminKey) { console.error('ANUBIS_ADMIN_KEY ausente no ambiente.'); process.exit(1); }
const base = (process.env.ANUBIS_BASE_URL || 'http://127.0.0.1:3210').replace(/\/+$/, '');
const headers = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
async function api(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}${data.error ? ` — ${typeof data.error === 'string' ? data.error : 'erro na resposta'}` : ''}`);
  return data;
}

// Preço manual e gate de revenda podem alterar o custo efetivo; falhar antes de mutar qualquer rota.
const pricing = await api('/admin/pricing');
if ((pricing.manualPrices || []).some(item => item?.provider === 'maxrouter')) throw new Error('Existe preço manual do MaxRouter; remova-o antes da importação.');
const readiness = await api('/admin/provider-readiness');
if (readiness.policy?.enforceResale === true) throw new Error('Gate de revenda está ativo; desative-o antes da importação.');

const connections = (await api('/admin/connections')).connections || [];
const connection = connections.find(item => item.provider === 'maxrouter' && item.active !== false);
if (!connection) throw new Error('Nenhuma conexão MaxRouter ativa encontrada.');

const refreshed = await api(`/admin/connections/${connection.id}/refresh`, { method: 'POST', body: '{}' });
const status = refreshed.connection?.status;
if (!['valid', 'endpoint_accepted'].includes(status)) throw new Error(`Conexão MaxRouter não validada (status: ${status || 'desconhecido'}).`);
if (refreshed.connection?.priceSource?.stale) throw new Error('Snapshot público de preços indisponível; refresh marcou os preços como stale.');
if (refreshed.connection?.priceSource?.count !== EXPECTED_PRICED) throw new Error(`Snapshot inesperado: ${refreshed.connection?.priceSource?.count ?? 0} preços, esperado ${EXPECTED_PRICED}.`);

const models = (await api(`/admin/connections/${connection.id}/models`)).models || [];
const priced = models.filter(model => model.pricing?.source === MAXROUTER_PRICING_PAGE && model.priceStale !== true);
if (priced.length !== EXPECTED_PRICED) throw new Error(`Catálogo com ${priced.length} modelos com preço, esperado ${EXPECTED_PRICED}.`);
if (priced.some(model => model.modality !== 'chat')) throw new Error('Modelo com preço fora da modalidade chat; ativação abortada.');
const candidates = priced.filter(model => model.enabled === false);
const alreadyEnabled = priced.length - candidates.length;
let enabled = 0; let failed = 0;
for (const model of candidates) {
  try {
    await api(`/admin/connections/${connection.id}/models`, { method: 'POST', body: JSON.stringify({ id: model.id, enabled: true }) });
    enabled++;
  } catch (error) {
    failed++;
    console.error(`Falha ao ativar ${model.id}: ${error.message}`);
  }
}
const finalModels = (await api(`/admin/connections/${connection.id}/models`)).models || [];
const finalEnabled = finalModels.filter(model => model.pricing?.source === MAXROUTER_PRICING_PAGE && model.priceStale !== true && model.enabled).length;
console.log(JSON.stringify({
  connectionId: connection.id,
  status,
  catalog: models.length,
  priced: priced.length,
  unpriced: models.length - priced.length,
  alreadyEnabled,
  candidates: candidates.length,
  enabled,
  failed,
  finalEnabled,
}, null, 2));
if (failed || finalEnabled !== EXPECTED_PRICED) process.exitCode = 1;

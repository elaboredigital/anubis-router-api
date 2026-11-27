// Cotação do dólar para estimativas em reais no admin. Não converte cobrança: só exibe.
// Automática: AwesomeAPI (comercial, ao vivo) e, se falhar, PTAX de venda do Banco Central (SGS série 1).
// Manual: valor fixado no admin, que prevalece sobre a automática.
const CACHE_MS = 3600_000;
export const DEFAULT_FX_CONFIG = Object.freeze({ mode: 'auto', manualRate: null });
const SOURCES = [
  {
    id: 'awesomeapi', label: 'AwesomeAPI (dólar comercial)', url: 'https://economia.awesomeapi.com.br/json/last/USD-BRL',
    parse: body => ({ rate: Number(body?.USDBRL?.bid), at: body?.USDBRL?.create_date ? new Date(body.USDBRL.create_date.replace(' ', 'T') + '-03:00').toISOString() : null }),
  },
  {
    id: 'bcb-ptax', label: 'Banco Central (PTAX venda)', url: 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados/ultimos/1?formato=json',
    parse: body => {
      const item = Array.isArray(body) ? body.at(-1) : null;
      const [day, month, year] = String(item?.data || '').split('/');
      return { rate: Number(String(item?.valor || '').replace(',', '.')), at: year ? `${year}-${month}-${day}T13:00:00.000Z` : null };
    },
  },
];

export function normalizeFxConfig(value) {
  const mode = value?.mode === 'manual' ? 'manual' : 'auto';
  const rate = Number(value?.manualRate);
  return { mode, manualRate: Number.isFinite(rate) && rate > 0 ? Math.round(rate * 10000) / 10000 : null };
}
export function validateFxConfig(data) {
  if (!data || !['auto', 'manual'].includes(data.mode)) return 'Escolha automática ou manual.';
  if (data.mode === 'manual') {
    const rate = Number(String(data.manualRate ?? '').replace(',', '.'));
    if (!Number.isFinite(rate) || rate < 1 || rate > 50) return 'Informe uma cotação entre 1 e 50 reais por dólar.';
  }
  return null;
}

export function createFx({ fetcher = fetch, now = () => Date.now() } = {}) {
  let cached = null;
  async function automatic() {
    if (cached && now() - cached.fetchedAtMs < CACHE_MS) return cached;
    const errors = [];
    for (const source of SOURCES) {
      try {
        const response = await fetcher(source.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { rate, at } = source.parse(await response.json());
        if (!Number.isFinite(rate) || rate < 1 || rate > 50) throw new Error('cotação fora do esperado');
        cached = { rate: Math.round(rate * 10000) / 10000, source: source.id, sourceLabel: source.label, quotedAt: at, fetchedAt: new Date(now()).toISOString(), fetchedAtMs: now() };
        return cached;
      } catch (error) { errors.push(`${source.id}: ${error.message}`); }
    }
    // Sem rede: mantém a última cotação conhecida, marcada como antiga.
    if (cached) return { ...cached, stale: true };
    return { rate: null, source: null, error: errors.join(' · ') };
  }
  return {
    async current(config) {
      const auto = await automatic();
      const { fetchedAtMs, ...autoPublic } = auto;
      if (config.mode === 'manual' && config.manualRate) return { mode: 'manual', rate: config.manualRate, source: 'manual', sourceLabel: 'Cotação fixada no admin', manualRate: config.manualRate, auto: autoPublic };
      return { mode: 'auto', ...autoPublic, manualRate: config.manualRate, auto: autoPublic };
    },
    reset() { cached = null; },
  };
}

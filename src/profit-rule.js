// Regra de lucro sobre o custo: a venda fica entre custo × 1,3 (30%) e custo × 1,8 (80%) e nunca passa do preço
// original do fabricante. Se nem com 30% de lucro a venda fica abaixo do original, o modelo não é ativado.
// Substitui o multiplicador fixo de 5×: multiplicadores de regra, plano ou padrão são trazidos para dentro da faixa.
export const MIN_MULTIPLIER = 1.3;
export const MAX_MULTIPLIER = 1.8;

/** Chamada típica usada para comparar preço por chamada com a tabela por token (mesma conta da home). */
export const TYPICAL_CALL = Object.freeze({ input: 25000, output: 2500 });

const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Valor comparável de um preço na unidade `billingType`: por chamada, ou entrada + saída por 1M tokens. */
export function comparableValue(price, billingType) {
  if (!price) return null;
  const input = num(price.input); const output = num(price.output); const request = num(price.request);
  if (billingType === 'request') {
    if (request !== null) return request;
    if (input === null && output === null) return null;
    return (input || 0) * TYPICAL_CALL.input / 1e6 + (output || 0) * TYPICAL_CALL.output / 1e6;
  }
  if (input === null && output === null) return null;
  return (input || 0) + (output || 0);
}

const clamp = value => Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, value));
const fixed = value => String(Number((Math.floor(value * 1e6) / 1e6).toFixed(6)));

/**
 * Multiplicador efetivo e se o modelo pode ser ativado.
 * `requested` é o multiplicador vigente (padrão, plano ou modelo); sem ele vale o teto de 80%.
 * Sem custo, custo zero (grátis) ou sem original cadastrado, não há teto pelo original.
 */
export function profitRule(referenceCost, original, requested) {
  const asked = num(requested);
  let multiplier = asked === null || asked === 0 ? MAX_MULTIPLIER : clamp(asked);
  const cost = referenceCost ? comparableValue(referenceCost, referenceCost.billingType) : null;
  const before = original && cost ? comparableValue(original, referenceCost.billingType) : null;
  if (cost && before !== null) multiplier = Math.min(multiplier, before / cost);
  const active = multiplier >= MIN_MULTIPLIER - 1e-9;
  return { multiplier: fixed(Math.max(multiplier, 0)), active, profitPercent: Math.round((multiplier - 1) * 1000) / 10 };
}

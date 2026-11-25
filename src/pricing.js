// Custo capturado do catálogo do fornecedor no momento da requisição.
// Preço manual é preço de venda: ele entra na cotação (saleSnapshot) e não substitui o custo.
export function priceSnapshot(providerModel, provider) {
  const catalog = providerModel?.pricing;
  if (!catalog) return null;
  const pick = (...names) => {
    for (const name of names) if (catalog[name] !== undefined && catalog[name] !== null) return catalog[name];
    return null;
  };
  return {
    billingType: providerModel.billingType,
    currency: pick('currency') || (provider === 'wusrouter' ? 'USD' : null),
    request: pick('request'),
    input: pick('input'),
    output: pick('output'),
    cacheRead: pick('cacheRead', 'cache_read'),
    cacheWrite: pick('cacheWrite', 'cache_write'),
    planOnly: !!providerModel.planOnly,
  };
}

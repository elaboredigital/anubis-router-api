// Perfis descrevem contratos conhecidos; não comprovam direitos, disponibilidade ou compatibilidade integral.
// site/docs são apenas ponteiros oficiais para o administrador conferir preços, modelos e termos.
export const connectors = [
  { id: 'xkiro', name: 'xKiro', base: 'https://api.xkiro.com', validation: '/v1/usage', catalog: '/v1/models?modality=all', authenticatedValidation: true, site: 'https://xkiro.com/', docs: 'https://docs.xkiro.com/guides/overview/' },
  { id: 'maxrouter', name: 'MaxRouter', base: 'https://api.maxrouter.ai', validation: '/v1/models', catalog: '/v1/models', authenticatedValidation: true, site: 'https://www.maxrouter.ai/', docs: 'https://www.maxrouter.ai/docs' },
  { id: 'geraikita', name: 'Geraikita AI', base: 'https://ai.geraikita.com', validation: '/v1/models', catalog: '/v1/models', authenticatedValidation: true, site: 'https://ai.geraikita.com/pt', docs: 'https://ai.geraikita.com/pt/docs' },
  { id: '1minai', name: '1min.AI', base: 'https://api.1min.ai/openai', validation: '/v1/models', catalog: '/v1/models', authenticatedValidation: true, chatOnly: true, site: 'https://1min.ai/', docs: 'https://docs.1min.ai/docs/api/intro' },
  { id: 'wusrouter', name: 'WusRouter', base: 'https://wusrouter.com', catalog: '/api/models', note: 'Catálogo público; validação autenticada e contratos pendentes.', site: 'https://wusrouter.com/', docs: 'https://wusrouter.com/documents' },
  { id: 'notholy', name: 'NotHoly', base: 'https://api.notholy.com', catalog: '/v1/models', note: 'Catálogo público; validação autenticada pendente.', site: 'https://notholy.com/', docs: 'https://docs.notholy.com/en' },
  { id: 'hcnsec', name: 'HCNSEC', base: 'https://api.hcnsec.cn', note: 'Caminhos e autenticação precisam de homologação.', site: 'https://api.hcnsec.cn/', docs: 'https://hcnote.cn/' },
  { id: 'a2e', name: 'A2E', base: 'https://api.a2e.ai', note: 'API de mídia assíncrona; adaptador e validação pendentes.', site: 'https://a2e.ai/pricing/', docs: 'https://video.a2e.ai/dev' },
  { id: 'cosmospro', name: 'CosmosPro', note: 'Endpoint e condições de revenda ainda não confirmados.', site: 'https://cosmospro.dev/', docs: null },
  { id: 'arena', name: 'Arena.ai', base: 'https://api.arena.ai', note: 'Condições de uso e revenda precisam de autorização; integração desabilitada.', site: 'https://arena.ai/', docs: 'https://platform.arena.ai/docs/api' },
  // Em avaliação desde 2026-11-26: só cadastro; endpoint, preços, catálogo e condições de revenda ainda não mapeados.
  { id: 'teamorouter', name: 'TeamoRouter', note: 'Fornecedor em avaliação; endpoint, preços e condições ainda não mapeados.', site: 'https://teamorouter.com/', docs: null },
  { id: 'zerouter', name: 'ZeRouter', note: 'Fornecedor em avaliação; endpoint, preços e condições ainda não mapeados.', site: 'https://www.zerouter.ai/', docs: null },
  { id: 'xiu', name: 'Xiu AI', note: 'Fornecedor em avaliação; endpoint, preços e condições ainda não mapeados.', site: 'https://xiu.ai/pricing', docs: null },
  { id: 'duck', name: 'Duck.ai', note: 'API de revenda não identificada; integração desabilitada.', site: 'https://duck.ai/', docs: 'https://duckduckgo.com/duckduckgo-help-pages/duckai' },
  { id: 'generic', name: 'OpenAI compatível (genérico)', note: 'Informe base HTTPS e confirme autenticação e direitos de uso.' },
];
export function connector(id) { return connectors.find(p => p.id === id); }

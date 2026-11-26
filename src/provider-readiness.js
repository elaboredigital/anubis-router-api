// Estado documental dos fornecedores. Nada aqui autoriza revenda, valida contrato ou prova disponibilidade.
// Os dados estáticos vêm das análises em docs/; ajustes administrativos são salvos como metadados auditáveis.
const BASELINE = {
  xkiro: {
    protocols: ['openai-chat', 'anthropic-messages', 'responses'],
    modalities: ['chat', 'image', 'search', 'tts'],
    billingUnits: ['request', 'token'],
    quotaSources: ['plano', 'boost', 'tokens-gratis'],
    variantPolicy: 'alias de provedor exige modelo efetivo conferido antes de fallback',
    evidence: ['docs/01-analise-xkiro.md', 'docs/34-xkiro-plano-e-precificacao.md'],
    restriction: 'Revenda/redistribuição depende de permissão escrita, inclusive para modelos grátis.',
  },
  maxrouter: {
    protocols: ['openai-chat', 'anthropic-messages'],
    modalities: ['chat'],
    billingUnits: ['token'],
    quotaSources: ['saldo-compartilhado'],
    variantPolicy: 'ID do catálogo não prova modelo servido; confirmar na homologação',
    evidence: ['docs/10-maxrouter-analise-publica.md', 'docs/11-maxrouter-tecnologia-api.md'],
    restriction: 'Termos, preço efetivo e direito de revenda não confirmados.',
  },
  geraikita: {
    protocols: ['openai-chat', 'anthropic-messages'],
    modalities: ['chat', 'image', 'video'],
    billingUnits: ['request', 'token', 'gp'],
    quotaSources: ['reserva', 'ajuste-posterior', 'promocao'],
    variantPolicy: 'variantes -token, -unli, Bansos e Unlimited não são equivalentes',
    evidence: ['docs/16-geraikita-tecnologia-api.md', 'docs/18-geraikita-implicacoes-anubis.md'],
    restriction: 'GP é IDR, não BRL. Revenda formal exige aprovação e X-Customer-Ref; grátis/Bansos/Unlimited não podem ser revendidos com chave gkr-.',
  },
  '1minai': {
    protocols: ['openai-chat', 'nativo', 'midia-assincrona'],
    modalities: ['chat'],
    billingUnits: ['credito'],
    quotaSources: ['credito-reservado'],
    variantPolicy: 'IDs com vl continuam somente texto no adaptador OpenAI',
    evidence: ['docs/29-1minai-analise.md'],
    restriction: 'Adaptador OpenAI é somente texto; white label/revenda exigem contrato e crédito não é token.',
  },
  wusrouter: {
    protocols: ['openai-chat', 'anthropic-messages'],
    modalities: ['chat'],
    billingUnits: ['request', 'token'],
    quotaSources: ['gratuita', 'bonus', 'assinatura', 'plan-only'],
    variantPolicy: 'jailbreak, TN, gratuitas e comunitárias não são equivalentes',
    evidence: ['docs/19-wusrouter-analise-publica.md', 'docs/20-wusrouter-tecnologia-api.md'],
    restriction: 'Validação autenticada, revenda e suboperadores não confirmados; preços plan_only não têm significado validado.',
  },
  notholy: {
    protocols: ['openai-chat', 'anthropic-messages', 'responses'],
    modalities: ['chat', 'image'],
    billingUnits: ['token'],
    quotaSources: ['credito', 'promocao'],
    variantPolicy: 'variantes abliteradas não devem ser vendidas como originais nem sofrer failover silencioso',
    evidence: ['docs/25-notholy-analise.md'],
    restriction: 'Licença de revenda dos modelos modificados não confirmada; idempotência é apenas em memória.',
  },
  hcnsec: {
    protocols: ['openai-chat', 'anthropic-messages', 'imagem'],
    modalities: ['chat', 'image'],
    billingUnits: ['request', 'token', 'cny'],
    quotaSources: ['assinatura', 'saldo', 'grupo'],
    variantPolicy: 'rótulos do painel não provam modelo real',
    evidence: ['docs/23-hcnsec-analise.md'],
    restriction: 'Endpoint e autenticação inconsistentes; pacote de gateway e direito de revenda não confirmados.',
  },
  a2e: {
    protocols: ['rest-assincrono'],
    modalities: ['image', 'video', 'voice', 'avatar'],
    billingUnits: ['credito', 'segundo', 'imagem'],
    quotaSources: ['credito'],
    variantPolicy: 'API de mídia não é compatível com chat OpenAI',
    evidence: ['docs/24-a2e-analise.md'],
    restriction: 'Webhook é melhor esforço; comercial use não prova sublicenciamento de acesso.',
  },
  cosmospro: {
    protocols: ['variaveis-de-ambiente'],
    modalities: ['chat'],
    billingUnits: ['assinatura'],
    quotaSources: ['plano'],
    variantPolicy: 'modelos efetivos e IDs não determinados',
    evidence: ['docs/27-cosmospro-analise.md'],
    restriction: 'Chave comum é intransferível; revenda fora do programa oficial é proibida.',
  },
  arena: {
    protocols: ['openai-chat', 'anthropic-messages', 'responses'],
    modalities: ['chat'],
    billingUnits: ['credito'],
    quotaSources: ['credito-promocional', 'limite-compartilhado'],
    variantPolicy: 'router oculta o modelo efetivo e não permite substituição confiável',
    evidence: ['docs/30-arena-ai-analise.md'],
    restriction: 'Termos restringem revenda, sublicenciamento e uso em produto concorrente; sem tabela de preço por ID.',
  },
  duck: {
    protocols: ['interface-de-chat'],
    modalities: ['chat'],
    billingUnits: [],
    quotaSources: ['limite-de-interface'],
    variantPolicy: 'seleção de modelo da interface não é capacidade de upstream',
    evidence: ['docs/31-duck-ai-analise.md'],
    restriction: 'Sem API comercial identificada; termos restringem consultas automatizadas e serviços de IA.',
  },
  // Fornecedores em avaliação (2026-11-26): cadastro preparado, nada mapeado ainda.
  teamorouter: {
    protocols: [], modalities: [], billingUnits: [], quotaSources: [],
    variantPolicy: 'modelos efetivos e IDs ainda não mapeados',
    evidence: ['docs/26-fornecedores-planejados.md'],
    restriction: 'Em avaliação: mapear endpoint, catálogo, preços e direitos de revenda antes de conectar.',
  },
  zerouter: {
    protocols: [], modalities: [], billingUnits: [], quotaSources: [],
    variantPolicy: 'modelos efetivos e IDs ainda não mapeados',
    evidence: ['docs/26-fornecedores-planejados.md'],
    restriction: 'Em avaliação: mapear endpoint, catálogo, preços e direitos de revenda antes de conectar.',
  },
  xiu: {
    protocols: [], modalities: [], billingUnits: [], quotaSources: [],
    variantPolicy: 'modelos efetivos e IDs ainda não mapeados',
    evidence: ['docs/26-fornecedores-planejados.md'],
    restriction: 'Em avaliação: mapear endpoint, catálogo, preços e direitos de revenda antes de conectar.',
  },
  generic: {
    protocols: ['openai-chat'],
    modalities: ['chat'],
    billingUnits: [],
    quotaSources: [],
    variantPolicy: 'convênio desconhecido: não presumir equivalência com outros fornecedores',
    evidence: [],
    restriction: 'Base, autenticação, direitos e preços precisam ser informados e conferidos.',
  },
};

// Bloqueios explícitos no código: a mudança de status administrativa não os remove.
export const CONNECTION_BLOCKED = {
  arena: 'Integração desabilitada: termos restringem revenda e uso concorrente.',
  duck: 'Integração desabilitada: sem API comercial identificada e consultas automatizadas são restritas.',
  a2e: 'Integração desabilitada: exige adaptador assíncrono e direitos de mídia.',
  cosmospro: 'Integração desabilitada: revenda de chave comum é proibida fora do programa oficial.',
  hcnsec: 'Integração desabilitada: endpoint, autenticação e condições do pacote não homologados.',
  teamorouter: 'Em avaliação: fornecedor ainda não mapeado nem escolhido.',
  zerouter: 'Em avaliação: fornecedor ainda não mapeado nem escolhido.',
  xiu: 'Em avaliação: fornecedor ainda não mapeado nem escolhido.',
};

export const DEFAULT_READINESS_POLICY = {
  // Desligado por padrão porque o projeto é uma simulação local; ligar bloqueia preço de venda e ativação de modelos.
  enforceResale: false,
  updatedAt: null,
};

const clean = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const STATUSES = ['planejado', 'em_homologacao', 'homologado'];
const FIELDS = ['resaleEvidence', 'jurisdiction', 'privacy', 'sla', 'owner', 'reviewedAt', 'note'];

export function buildReadiness(profile, overrides = [], policy = DEFAULT_READINESS_POLICY) {
  if (!profile) return null;
  const base = BASELINE[profile.id] || { protocols: [], modalities: [], billingUnits: [], quotaSources: [], variantPolicy: null, evidence: [], restriction: null };
  const saved = overrides.find(item => item?.providerId === profile.id) || {};
  const status = STATUSES.includes(saved.status) ? saved.status : 'planejado';
  const blockReason = CONNECTION_BLOCKED[profile.id] || null;
  const resaleConfirmed = saved.resaleConfirmed === true;
  const evidence = clean(saved.resaleEvidence);
  const reviewedAt = clean(saved.reviewedAt, 40);
  return {
    providerId: profile.id,
    name: profile.name,
    status,
    ...Object.fromEntries(FIELDS.map(field => [field, clean(saved[field], field === 'note' ? 400 : 160)])),
    resaleConfirmed,
    blockedReason: blockReason,
    connectable: !blockReason,
    commercialReady: !blockReason && status === 'homologado' && resaleConfirmed && !!evidence && !!reviewedAt,
    protocols: base.protocols,
    modalities: base.modalities,
    billingUnits: base.billingUnits,
    quotaSources: base.quotaSources,
    variantPolicy: base.variantPolicy,
    evidence: base.evidence,
    restriction: base.restriction,
    policy: { enforceResale: policy?.enforceResale === true },
  };
}

export function normalizeReadinessUpdate(data = {}, current = {}) {
  const next = { ...current, providerId: data.providerId || current.providerId };
  if (data.status !== undefined) next.status = clean(data.status, 40);
  if (data.resaleConfirmed !== undefined) next.resaleConfirmed = data.resaleConfirmed === true;
  for (const field of FIELDS) if (data[field] !== undefined) next[field] = clean(data[field], field === 'note' ? 400 : 160);
  if (data.enforceResale !== undefined) next.enforceResale = data.enforceResale === true;
  return next;
}

export function validateReadinessUpdate(next, profile, current = {}) {
  if (!profile) return 'Fornecedor desconhecido.';
  if (!STATUSES.includes(next.status)) return 'Status de homologação inválido.';
  if (next.reviewedAt && !/^\d{4}-\d{2}-\d{2}$/.test(next.reviewedAt)) return 'Data de revisão use AAAA-MM-DD.';
  if (next.resaleConfirmed && !next.resaleEvidence) return 'Confirmação de revenda exige referência escrita da autorização.';
  if (next.status === 'homologado' && (!next.resaleConfirmed || !next.resaleEvidence || !next.reviewedAt)) return 'Homologação exige revenda confirmada, evidência e data de revisão.';
  if (CONNECTION_BLOCKED[profile.id] && (next.status === 'homologado' || next.resaleConfirmed)) return 'Fornecedor bloqueado por restrição contratual; atualize o código após autorização expressa.';
  const before = {
    status: current.status || 'planejado', resaleConfirmed: current.resaleConfirmed === true,
    resaleEvidence: current.resaleEvidence || '', reviewedAt: current.reviewedAt || '',
  };
  const after = {
    status: next.status, resaleConfirmed: next.resaleConfirmed,
    resaleEvidence: next.resaleEvidence || '', reviewedAt: next.reviewedAt || '',
  };
  if (JSON.stringify(before) === JSON.stringify(after) && !next.note && !next.owner && !next.jurisdiction && !next.privacy && !next.sla) return 'Nenhuma alteração informada.';
  return null;
}

/** Gate opcional: quando ativo, preço de venda e ativação de modelos exigem homologação documentada. */
export function commercialBlock(providerId, readinessList, policy = DEFAULT_READINESS_POLICY) {
  if (policy?.enforceResale !== true) return null;
  const item = readinessList.find(entry => entry.providerId === providerId);
  if (item?.commercialReady) return null;
  return `Fornecedor ${providerId} sem homologação documentada para venda. Registre direito de revenda e evidência antes de definir preço ou ativar modelos.`;
}

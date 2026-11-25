// Diagnóstico administrativo do gateway. Não testa a ferramenta externa, não faz inferência e não lida com chaves reais.
export function buildConnectDiagnostic({ auth, modelCount, routeCount, connectionCount, keyCount, at = new Date().toISOString() }) {
  const check = (id, label, ok, detail) => ({ id, label, ok, detail });
  const checks = [
    check('gateway', 'Gateway disponível', true, 'O painel está respondendo nesta instalação.'),
    check('authentication', 'Autenticação de chave Anubis', auth === true,
      auth === true ? 'Uma chave temporária, criada e descartada apenas em memória, foi aceita pelo gateway.' : 'O gateway não aceitou a chave temporária de teste.'),
    check('models', 'Modelos disponíveis', modelCount > 0,
      modelCount > 0 ? `${modelCount} modelo(s) habilitado(s) e utilizável(is).` : 'Nenhum modelo habilitado com credencial ativa; configure Fornecedores e Rotas.'),
    check('routes', 'Rotas habilitadas', routeCount > 0,
      routeCount > 0 ? `${routeCount} rota(s) habilitada(s).` : 'Nenhuma rota habilitada; configure Rotas antes de conectar a ferramenta.'),
    check('connections', 'Credenciais de fornecedor ativas', connectionCount > 0,
      connectionCount > 0 ? `${connectionCount} credencial(is) ativa(s).` : 'Nenhuma credencial de fornecedor ativa; cadastre-a em Fornecedores.'),
    check('keys', 'Chave Anubis criada', keyCount > 0,
      keyCount > 0 ? `${keyCount} chave(s) ativa(s) disponível(is) para as ferramentas.` : 'Nenhuma chave Anubis ativa; crie uma em Chaves de acesso.'),
  ];
  return {
    ok: checks.every(item => item.ok),
    checks,
    modelCount,
    checkedAt: at,
    scope: 'somente gateway local; não valida a ferramenta externa nem consome inferência',
  };
}

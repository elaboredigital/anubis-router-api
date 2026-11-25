# Anubis Router — API

Projeto independente da API/gateway do Anubis Router. Destino: **api.anubisrouter.com**.
Este diretório tem seu próprio repositório Git (`git -C api status`); o repositório da raiz o ignora.

## O que vive aqui

| Pasta | Conteúdo |
|---|---|
| `src/` | servidor HTTP, gateway `/v1/*`, área do cliente `/me/*`, endpoints `/admin/*`, persistência, roteamento, preços, ledger, indicações e telemetria |
| `test/` | testes unitários e de integração da API (109 testes) |
| `scripts/` | servidor local com túnel SSH para o banco e importação do catálogo do MaxRouter |
| `data/` | estado local em arquivos (ignorado pelo Git); em produção, `DATABASE_URL` aponta para o Postgres |
| `extension/` | manifesto e VSIX servidos por `/admin/extension/*`; o build da API não depende de outros diretórios |

A API não possui interface própria. As rotas de página (`/`, `/models`, `/users`, ...) só são
servidas quando `ANUBIS_WEB_ROOT` aponta para uma pasta que contém `public/`. Durante a transição
no monorepo, o valor `..` faz isso e permite continuar desenvolvendo os três projetos na mesma
pasta. Em uma instalação isolada, essas rotas respondem `404`.

## Executar

```bash
cp .env.example .env       # preencher ANUBIS_ADMIN_KEY e ANUBIS_ENCRYPTION_KEY
npm ci
npm run dev                # local, com túnel SSH opcional para o banco de produção
npm start                  # produção
npm test                   # 109 testes, sem chamadas externas
```

`npm start` carrega automaticamente `api/.env`. Na raiz do monorepo, `npm start` e `npm run dev`
carregam o `.env` da raiz, entram em `api/` e definem `ANUBIS_WEB_ROOT=..`.

### Variáveis

| Variável | Uso |
|---|---|
| `ANUBIS_ADMIN_KEY` | autenticação dos endpoints `/admin/*` |
| `ANUBIS_ENCRYPTION_KEY` | chave hexadecimal de 64 caracteres usada para cifrar credenciais de fornecedores |
| `DATABASE_URL` | Postgres; sem ela, o estado fica em `data/` |
| `ANUBIS_PUBLIC_URL` | origens aceitas pelo CORS (site público e, no futuro, o painel) |
| `PORT`, `HOST` | escuta, padrão `3210` / `127.0.0.1` |
| `ANUBIS_WEB_ROOT` | apenas transição: raiz da interface servida por este processo |

## Docker

O build usa somente o conteúdo de `api/`; o VSIX já está incluído em `api/extension/`:

```bash
docker build -t anubis-api ./api
```

O healthcheck usa `GET /v1/models`, que responde `401` quando o processo está saudável.

## Contrato de API

- `/v1/models`, `/v1/chat/completions`, `/v1/messages`, `/v1/responses`: gateway autenticado por chave Anubis.
- `/me`, `/me/summary`, `/me/keys`, `/me/stats`, `/me/referrals`: área do titular da chave, sem login administrativo.
- `/admin/*`: configuração de fornecedores, rotas, planos, preços, chaves, usuários, indicações, razão e sistema.
- `/client-session`: revoga a sessão temporária emitida pelo painel.

O domínio `admin.anubisrouter.com` consumirá `/admin/*`; o site `anubisrouter.com` consumirá
`/v1/*` e `/me/*`. Nenhum segredo de fornecedor é enviado ao navegador.

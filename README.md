# E-stats — BFF de Esports (CS2)

> **Versão Atual:** `1.0.0-pre-alpha` (Pré-alpha 1.0.0)

Backend-for-Frontend do app de acompanhamento de Esports inspirado no Apple Sports.
Prioridade máxima: **latência quase zero no placar ao vivo**.

## Stack

| Camada     | Tecnologia                         | Motivo                                        |
| ---------- | ---------------------------------- | --------------------------------------------- |
| API        | Node.js 24 + TypeScript + Fastify  | Baixo overhead por requisição                 |
| Tempo real | WebSocket (`@fastify/websocket`/`ws`) | Conexão persistente, sem polling           |
| Banco      | PostgreSQL 16                      | Dados relacionais (times, torneios, partidas) |
| Cache/Bus  | Redis 7                            | Estado quente + pub/sub do placar             |

## Estrutura

```
src/
├── api/        # Rotas HTTP e WebSocket (camada de entrada)
├── config/     # Carga e validação de variáveis de ambiente
├── core/       # Infra compartilhada (Postgres, Redis)
├── providers/  # Adapters dos provedores de dados (Cito, PandaScore)
└── server.ts   # Bootstrap da aplicação
```

## Rodando localmente (Docker)

```bash
cp .env.example .env          # credenciais padrão de dev
docker compose up --build     # sobe api + db + redis
```

- API Health: http://localhost:3000/health
<!-- [UPDATE]: Módulo 5 — Documentação das rotas REST da Home Screen. -->
- API REST (Partidas): `http://localhost:3000/api/matches` e `http://localhost:3000/api/matches/:id` (veja [`docs/API_REST_GUIDE.md`](docs/API_REST_GUIDE.md))
- WebSocket: `ws://localhost:3000/ws/live/:matchId` (veja [`docs/CLIENT_WS_GUIDE.md`](docs/CLIENT_WS_GUIDE.md))
- Postgres: `localhost:5432` | Redis: `localhost:6379`

Alterações em `./src` disparam **hot reload** automaticamente no container.
Alterações em `package.json` exigem rebuild: `docker compose up --build`.

<!-- [UPDATE]: Seção adicionada no Módulo 2 (modelagem de dados e cache). -->
## Dados

- **Postgres** (`database/init.sql`): torneios, times, partidas, mapas e mapeamento de IDs dos provedores.
  O script roda **apenas com o volume vazio**. Para reaplicar alterações: `docker compose down -v && docker compose up --build`.
- **Redis** (`src/core/live-state.cache.ts`): snapshot ao vivo em `match:live:{matchId}` (TTL 12h)
  e avisos de atualização no canal Pub/Sub `channel:match:{matchId}`.
- **Modelo Canônico** (`src/core/models.ts`): tipos compartilhados, incluindo `CS2LiveState`.

## Rodando sem Docker para a API

```bash
npm install
docker compose up -d db redis   # apenas infraestrutura
npm run dev                     # tsx watch no host
```

# E-stats — BFF de Esports (CS2)

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

- API: http://localhost:3000/health
- WebSocket: `ws://localhost:3000/ws/live` (envie `{"type":"ping"}`)
- Postgres: `localhost:5432` | Redis: `localhost:6379`

Alterações em `./src` disparam **hot reload** automaticamente no container.
Alterações em `package.json` exigem rebuild: `docker compose up --build`.

## Rodando sem Docker para a API

```bash
npm install
docker compose up -d db redis   # apenas infraestrutura
npm run dev                     # tsx watch no host
```

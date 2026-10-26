# Guia da API REST (Home Screen & Detalhes da Partida)

> **Contexto:** Este guia documenta os endpoints HTTP REST do BFF **E-stats** usados pelos aplicativos **iOS** e **Android** para renderizar os cards de partidas da **Home Screen** (estilo Apple Sports) e a tela de **Detalhes da Série** (incluindo o veto de mapas).
> Para atualizações de rounds, economia e killfeed em tempo real, consulte o [Guia de WebSocket (`CLIENT_WS_GUIDE.md`)](./CLIENT_WS_GUIDE.md).

---

## Por que o Payload já vem Aninhado?

Redes móveis (4G/5G) possuem latência de handshake mais alta. Para evitar o problema de **N+1 requisições** no cliente (buscar a lista de partidas e depois disparar chamadas separadas para buscar cada time e campeonato), o BFF executa `JOIN` no PostgreSQL e devolve um **DTO aninhado pronto para o Card** (`tournament`, `team_a`, `team_b`).

---

## 1. Listar Partidas da Home Screen

```http
GET /api/matches
```

Retorna a lista de partidas ordenada automaticamente por prioridade visual:
1. Partidas **`live`** (ao vivo) sempre no topo;
2. Partidas **`scheduled`** (agendadas) em ordem cronológica;
3. Demais status (`finished`, `postponed`, `canceled`).

### Query Parameters (Opcionais)

| Parâmetro | Tipo     | Exemplo        | Descrição                                                                 |
| --------- | -------- | -------------- | ------------------------------------------------------------------------- |
| `status`  | `string` | `live`         | Filtra pelo status (`scheduled`, `live`, `finished`, `postponed`, `canceled`). |
| `date`    | `string` | `2026-10-26`   | Filtra partidas agendadas para a data informada (formato ISO `YYYY-MM-DD` em UTC). |

**Exemplos de chamadas:**
- Todas as partidas: `GET /api/matches`
- Apenas ao vivo: `GET /api/matches?status=live`
- Jogos do dia: `GET /api/matches?date=2026-10-26`
- Combinado: `GET /api/matches?status=scheduled&date=2026-10-26`

### Resposta `200 OK` (Exemplo de Payload JSON)

```json
[
  {
    "id": "b7c9e0f2-1d4a-4b8c-9e2f-3a5d7c9e1b20",
    "format": "BO3",
    "status": "live",
    "scheduled_at": "2026-10-26T20:00:00.000Z",
    "winner_id": null,
    "tournament": {
      "id": "a1e2d3c4-5b6a-4c7d-8e9f-0a1b2c3d4e5f",
      "name": "IEM Katowice 2026",
      "tier": "S"
    },
    "team_a": {
      "id": "11111111-2222-4333-8444-555555555555",
      "name": "FURIA",
      "acronym": "FUR",
      "logo_url": "https://cdn.estats.app/teams/furia.png"
    },
    "team_b": {
      "id": "66666666-7777-4888-8999-000000000000",
      "name": "Team Vitality",
      "acronym": "VIT",
      "logo_url": "https://cdn.estats.app/teams/vitality.png"
    }
  }
]
```

> **Dica de UI (Times "TBD"):** Em chaves de playoffs, `team_a` ou `team_b` pode vir como `null` quando o adversário ainda não foi definido pela partida anterior. Nesses casos, exiba o placeholder `"TBD"` no card.

---

## 2. Buscar Detalhes de uma Partida (Com Mapas / Veto)

```http
GET /api/matches/:id
```

Retorna os mesmos dados do Card da partida acrescidos do array `maps` (ordenado por `map_number` de 1 a 5), representando os mapas escolhidos no veto e o placar final de cada mapa encerrado.

### Parâmetros de Rota

| Parâmetro | Tipo   | Descrição                       |
| --------- | ------ | ------------------------------- |
| `id`      | `UUID` | Identificador canônico da série |

### Resposta `200 OK` (Exemplo de Payload JSON)

```json
{
  "id": "b7c9e0f2-1d4a-4b8c-9e2f-3a5d7c9e1b20",
  "format": "BO3",
  "status": "live",
  "scheduled_at": "2026-10-26T20:00:00.000Z",
  "winner_id": null,
  "tournament": {
    "id": "a1e2d3c4-5b6a-4c7d-8e9f-0a1b2c3d4e5f",
    "name": "IEM Katowice 2026",
    "tier": "S"
  },
  "team_a": {
    "id": "11111111-2222-4333-8444-555555555555",
    "name": "FURIA",
    "acronym": "FUR",
    "logo_url": "https://cdn.estats.app/teams/furia.png"
  },
  "team_b": {
    "id": "66666666-7777-4888-8999-000000000000",
    "name": "Team Vitality",
    "acronym": "VIT",
    "logo_url": "https://cdn.estats.app/teams/vitality.png"
  },
  "maps": [
    {
      "id": "c1111111-2222-4333-8444-555555555501",
      "map_number": 1,
      "map_name": "de_inferno",
      "pick_team_id": "11111111-2222-4333-8444-555555555555",
      "status": "finished",
      "team_a_score": 13,
      "team_b_score": 9
    },
    {
      "id": "c1111111-2222-4333-8444-555555555502",
      "map_number": 2,
      "map_name": "de_mirage",
      "pick_team_id": "66666666-7777-4888-8999-000000000000",
      "status": "live",
      "team_a_score": 0,
      "team_b_score": 0
    },
    {
      "id": "c1111111-2222-4333-8444-555555555503",
      "map_number": 3,
      "map_name": "de_nuke",
      "pick_team_id": null,
      "status": "upcoming",
      "team_a_score": 0,
      "team_b_score": 0
    }
  ]
}
```

> **Dica de UI (Veto de Mapas):**
> - Quando `pick_team_id` é igual a `team_a.id` ou `team_b.id`, exiba a badge `"PICK FUR"` / `"PICK VIT"`.
> - Quando `pick_team_id` é `null`, trata-se do mapa **Decider** (mapa desempate que restou no veto).

---

## 3. Códigos de Status HTTP

| Código | Cenário                                                                 |
| ------ | ----------------------------------------------------------------------- |
| `200`  | Sucesso na busca da lista ou do detalhe da partida.                     |
| `404`  | `GET /api/matches/:id` quando o UUID não existe ou está malformado.     |
| `500`  | Erro inesperado de banco de dados ou formato de filtro inválido.        |

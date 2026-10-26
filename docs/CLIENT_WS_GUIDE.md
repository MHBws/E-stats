# Guia de Integração WebSocket (Clientes iOS / Android)

> **Contexto:** Este documento descreve como os aplicativos mobile (iOS e Android) devem se conectar ao BFF do **E-stats** para receber o placar ao vivo de CS2 com latência quase zero, inspirado na experiência do Apple Sports.

---

## 1. Formato da URL de Conexão

Cada tela de partida ao vivo deve abrir uma conexão WebSocket dedicada informando o **UUID canônico da partida** (`matchId`):

```text
ws://<HOST>:<PORT>/ws/live/:matchId
```

- **Desenvolvimento Local:** `ws://localhost:3000/ws/live/00000000-0000-4000-8000-000000000001` (no emulador Android use `10.0.2.2` no lugar de `localhost`).
- **Produção (TLS):** `wss://api.estats.app/ws/live/:matchId`

---

## 2. Estado Completo a Cada Atualização (Full Snapshot vs. Deltas)

Para simplificar ao máximo a camada de estado no iOS (SwiftUI/`@Observable`) e no Android (Jetpack Compose/`StateFlow`), **o servidor SEMPRE envia o snapshot completo da partida (`CS2LiveState`)**, e **nunca** apenas *deltas* ou *diffs* parciais:

1. **Hidratação Imediata ao Conectar:** Assim que o handshake WebSocket conclui, o servidor busca o estado atual no Redis e envia imediatamente uma mensagem `match:state`. O app pode renderizar o placar no primeiro frame sem aguardar o próximo evento do jogo.
2. **Atualizações em Tempo Real (Pub/Sub):** A cada kill, plant de bomba ou fim de round, um novo envelope `match:state` contendo o `CS2LiveState` completo é enviado.
3. **Prevenção de Eventos Fora de Ordem:** O objeto `CS2LiveState` possui o campo numérico monotônico `sequence`. O cliente deve substituir o estado local pelo novo snapshot **apenas se `novo.sequence >= atual.sequence`**.

### Exemplo de Payload (`match:state`)

```json
{
  "type": "match:state",
  "matchId": "00000000-0000-4000-8000-000000000001",
  "timestamp": 1793056800000,
  "data": {
    "matchId": "00000000-0000-4000-8000-000000000001",
    "game": "cs2",
    "status": "live",
    "format": "BO3",
    "currentMap": { "mapNumber": 1, "mapName": "de_mirage", "status": "live" },
    "round": {
      "number": 14,
      "phase": "live",
      "clock": { "remainingMs": 72000, "capturedAt": 1793056800000, "running": true }
    },
    "teams": {
      "teamA": {
        "teamId": "00000000-0000-4000-8000-0000000000a1",
        "name": "FURIA",
        "acronym": "FUR",
        "side": "T",
        "score": 7,
        "mapsWon": 0,
        "playersAlive": 4,
        "economy": { "money": 14200, "equipmentValue": 24500, "lossBonusLevel": 1, "buyType": "full" }
      },
      "teamB": {
        "teamId": "00000000-0000-4000-8000-0000000000b2",
        "name": "Team Vitality",
        "acronym": "VIT",
        "side": "CT",
        "score": 6,
        "mapsWon": 0,
        "playersAlive": 3,
        "economy": { "money": 9800, "equipmentValue": 26100, "lossBonusLevel": 2, "buyType": "full" }
      }
    },
    "bomb": { "state": "carried", "site": null, "plantedAt": null },
    "killfeed": [],
    "sequence": 42,
    "updatedAt": 1793056800000,
    "source": "cito"
  }
}
```

> **Nota:** Se a partida ainda não tiver estado ao vivo em cache no momento da conexão, `"data"` virá como `null`. O cliente deve manter a conexão aberta para receber o primeiro snapshot assim que a partida iniciar.

---

## 3. Heartbeat (Ping / Pong)

Redes móveis sofrem quedas silenciosas frequentes (troca entre Wi-Fi e 4G/5G, túneis, bloqueio de tela). Para evitar conexões zumbis e vazamento de memória no servidor:

- O BFF envia um **Ping a cada 30 segundos** (tanto via frame de controle WebSocket RFC 6455 quanto via mensagem JSON `{"type": "ping", "timestamp": ...}`).
- **Obrigação do Cliente:** O app deve responder ao Ping antes do próximo ciclo (30s), caso contrário o servidor executará `ws.terminate()` e removerá a inscrição da partida:
  - As bibliotecas padrão (`URLSessionWebSocketTask` no iOS e `OkHttp` no Android) já respondem automaticamente aos frames nativos de `ping` do protocolo WebSocket.
  - Caso utilize um wrapper que exponha apenas mensagens de texto, ao receber `{"type": "ping"}`, responda imediatamente com:
    ```json
    { "type": "pong" }
    ```
  - O cliente também pode enviar `{"type": "ping"}` a qualquer momento para medir latência (RTT) e receberá `{"type": "pong", "timestamp": ...}`.

---

## 4. Reconexão com Exponential Backoff

Quando a conexão cair (`onClose` / `onFailure`), **nunca reconecte em loop imediato (`0ms`)**, pois isso causa *thundering herd* no servidor durante oscilações de rede. Implemente **Exponential Backoff** com limite máximo:

| Tentativa | Atraso antes de reconectar |
| --------- | -------------------------- |
| 1ª        | **1s** (`1000ms`)          |
| 2ª        | **2s** (`2000ms`)          |
| 3ª        | **4s** (`4000ms`)          |
| 4ª        | **8s** (`8000ms`)          |
| 5ª+       | **16s** (teto máximo + *jitter* aleatório de 0–500ms) |

Assim que a reconexão tiver sucesso e a primeira mensagem `match:state` for recebida, **zere o contador de tentativas** de volta para `0`.

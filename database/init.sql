-- =============================================================================
-- database/init.sql — Schema inicial do PostgreSQL (Modelo Canônico)
-- -----------------------------------------------------------------------------
-- O QUE: Cria as tabelas de torneios, times, partidas, mapas e o mapeamento de
--        IDs dos provedores externos (Cito, PandaScore).
-- POR QUE: O Postgres guarda os dados "frios"/históricos e relacionais. O estado
--          AO VIVO do placar (rounds, economia, bomba...) NÃO fica aqui: ele vive
--          no Redis, pois muda várias vezes por segundo e exige latência mínima.
--
-- QUANDO RODA: A imagem oficial do Postgres executa os arquivos de
--   /docker-entrypoint-initdb.d/ SOMENTE na primeira inicialização (volume vazio).
--   Para reaplicar após alterações: `docker compose down -v && docker compose up`.
--   (Futuramente este arquivo deve evoluir para uma ferramenta de migrations.)
-- =============================================================================

-- Executa tudo em uma transação: ou o schema é criado por completo, ou nada é.
BEGIN;

-- -----------------------------------------------------------------------------
-- Função utilitária: mantém a coluna updated_at sempre atualizada.
-- POR QUE: Permite sincronizações incrementais com os provedores
-- ("o que mudou desde X?") sem depender da aplicação lembrar de setar o campo.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- tournaments — Campeonatos (ex.: IEM Katowice, PGL Major)
-- -----------------------------------------------------------------------------
-- IDs UUID com gen_random_uuid() (nativo desde o PG13, sem extensões):
-- podem ser gerados em qualquer camada sem colisão e não expõem volume de dados.
CREATE TABLE tournaments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  -- Tier no padrão de mercado (Liquipedia/PandaScore): S = elite ... D = amador.
  -- CHECK em vez de ENUM: mais simples de evoluir (ALTER de ENUM é restritivo).
  tier        TEXT CHECK (tier IN ('S', 'A', 'B', 'C', 'D')),
  start_date  DATE,
  end_date    DATE,
  -- NUMERIC evita erros de arredondamento de ponto flutuante em valores (USD).
  prize_pool  NUMERIC(14, 2) CHECK (prize_pool >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tournaments_dates_chk CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

-- -----------------------------------------------------------------------------
-- teams — Equipes (ex.: FURIA, Vitality)
-- -----------------------------------------------------------------------------
CREATE TABLE teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  -- Sigla curta exibida no placar compacto (estilo Apple Sports), ex.: "FUR".
  acronym     VARCHAR(10),
  logo_url    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- matches — Séries entre dois times (BO1/BO3/BO5)
-- -----------------------------------------------------------------------------
CREATE TABLE matches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE: remover um torneio remove suas partidas (dados dependentes).
  tournament_id  UUID NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
  -- RESTRICT: impede apagar um time que tenha histórico de partidas.
  team_a_id      UUID REFERENCES teams (id) ON DELETE RESTRICT,
  team_b_id      UUID REFERENCES teams (id) ON DELETE RESTRICT,
  format         TEXT NOT NULL DEFAULT 'BO3' CHECK (format IN ('BO1', 'BO3', 'BO5')),
  status         TEXT NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled', 'live', 'finished', 'postponed', 'canceled')),
  scheduled_at   TIMESTAMPTZ NOT NULL,
  winner_id      UUID REFERENCES teams (id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- team_a/b podem ser NULL enquanto o chaveamento não está definido ("TBD").
  CONSTRAINT matches_distinct_teams_chk CHECK (team_a_id IS NULL OR team_b_id IS NULL OR team_a_id <> team_b_id),
  -- Integridade: o vencedor precisa ser um dos dois participantes.
  CONSTRAINT matches_winner_chk CHECK (winner_id IS NULL OR winner_id = team_a_id OR winner_id = team_b_id)
);

-- Índice para a tela principal: "partidas ao vivo / próximas" ordenadas por horário.
CREATE INDEX matches_status_scheduled_idx ON matches (status, scheduled_at);
-- Índices para FKs: o Postgres NÃO cria automaticamente; aceleram joins e filtros.
CREATE INDEX matches_tournament_idx ON matches (tournament_id);
CREATE INDEX matches_team_a_idx ON matches (team_a_id);
CREATE INDEX matches_team_b_idx ON matches (team_b_id);
-- Índice parcial: só as partidas ao vivo (poucas linhas) — consulta quentíssima.
CREATE INDEX matches_live_idx ON matches (scheduled_at) WHERE status = 'live';

-- -----------------------------------------------------------------------------
-- match_maps — Mapas de uma série (ex.: Mirage, Inferno, Nuke)
-- -----------------------------------------------------------------------------
CREATE TABLE match_maps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id      UUID NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  -- Ordem do mapa na série (1, 2, 3...). Necessário para exibir a sequência.
  map_number    SMALLINT NOT NULL CHECK (map_number BETWEEN 1 AND 5),
  map_name      TEXT NOT NULL,
  -- Time que escolheu o mapa; NULL = decider (mapa que sobrou no veto).
  pick_team_id  UUID REFERENCES teams (id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'live', 'finished')),
  -- Placar FINAL de rounds do mapa (o placar ao vivo fica no Redis).
  team_a_score  SMALLINT NOT NULL DEFAULT 0 CHECK (team_a_score >= 0),
  team_b_score  SMALLINT NOT NULL DEFAULT 0 CHECK (team_b_score >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Um mesmo número de mapa não pode se repetir na série.
  CONSTRAINT match_maps_number_uq UNIQUE (match_id, map_number)
);

CREATE INDEX match_maps_pick_team_idx ON match_maps (pick_team_id);

-- -----------------------------------------------------------------------------
-- provider_mappings — "Tradutor" de IDs externos -> IDs internos
-- -----------------------------------------------------------------------------
-- POR QUE: Cada provedor tem seus próprios IDs. Ao receber um evento ao vivo
-- (ex.: Cito diz "match 98765"), precisamos achar nosso UUID em O(log n) para
-- atualizar o placar certo. Também permite cruzar o mesmo time entre provedores.
-- entity_id é polimórfico (aponta para tabelas diferentes), por isso não há FK.
CREATE TABLE provider_mappings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id    UUID NOT NULL,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('tournament', 'team', 'match', 'match_map')),
  provider     TEXT NOT NULL CHECK (provider IN ('cito', 'pandascore')),
  -- TEXT: provedores usam IDs numéricos, slugs ou UUIDs indistintamente.
  external_id  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Caminho de ingestão (externo -> interno): único e indexado pela constraint.
  CONSTRAINT provider_mappings_external_uq UNIQUE (provider, entity_type, external_id),
  -- Caminho inverso (interno -> externo): uma entidade tem no máx. 1 ID por provedor.
  CONSTRAINT provider_mappings_entity_uq UNIQUE (entity_type, entity_id, provider)
);

-- -----------------------------------------------------------------------------
-- Triggers de updated_at para todas as tabelas.
-- -----------------------------------------------------------------------------
CREATE TRIGGER tournaments_set_updated_at BEFORE UPDATE ON tournaments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER teams_set_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER matches_set_updated_at BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER match_maps_set_updated_at BEFORE UPDATE ON match_maps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER provider_mappings_set_updated_at BEFORE UPDATE ON provider_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;

/**
 * Migrazioni versionate.
 *
 * Sono incorporate nel codice invece di essere lette da file .sql perché il
 * bundler delle funzioni serverless include solo ciò che viene importato: un
 * file di testo accanto al sorgente non arriverebbe in produzione. L'ordine
 * dell'array è l'ordine di applicazione e non va mai cambiato; le migrazioni
 * già applicate non si modificano, se ne aggiunge una nuova.
 */

export interface Migration {
  name: string;
  sql: string;
}

const INIT = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Identità ------------------------------------------------------------------

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name        text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  pin_hash            text,
  recovery_code_hash  text,
  failed_attempts     integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Una sola riga: indica se l'istanza è già stata rivendicata e da chi.
CREATE TABLE instance_state (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  owner_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1
);
INSERT INTO instance_state (id) VALUES (true);

-- Campagne -------------------------------------------------------------------

CREATE TABLE campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description     text NOT NULL DEFAULT '',
  player_slots    integer NOT NULL CHECK (player_slots BETWEEN 1 AND 8),
  rule_set        jsonb NOT NULL,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX campaigns_owner_idx ON campaigns (owner_user_id) WHERE deleted_at IS NULL;

CREATE TABLE campaign_memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('game_master', 'player')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (campaign_id, user_id)
);
-- Un solo Game Master per campagna.
CREATE UNIQUE INDEX campaign_single_game_master
  ON campaign_memberships (campaign_id)
  WHERE role = 'game_master';

-- File e mappe ---------------------------------------------------------------

CREATE TABLE assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('map', 'token', 'other')),
  storage_key   text NOT NULL UNIQUE,
  mime_type     text NOT NULL,
  byte_size     bigint NOT NULL CHECK (byte_size >= 0),
  width_px      integer CHECK (width_px IS NULL OR width_px > 0),
  height_px     integer CHECK (height_px IS NULL OR height_px > 0),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1
);
CREATE INDEX assets_campaign_idx ON assets (campaign_id, kind);

CREATE TABLE map_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  asset_id      uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  detection     jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1
);
CREATE INDEX map_assets_campaign_idx ON map_assets (campaign_id);

-- Scene e griglia ------------------------------------------------------------

CREATE TABLE scenes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  map_asset_id    uuid REFERENCES map_assets(id) ON DELETE SET NULL,
  ambient_darkness real NOT NULL DEFAULT 0 CHECK (ambient_darkness BETWEEN 0 AND 1),
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX scenes_campaign_idx ON scenes (campaign_id) WHERE deleted_at IS NULL;

CREATE TABLE grid_configurations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id        uuid NOT NULL UNIQUE REFERENCES scenes(id) ON DELETE CASCADE,
  cell_size_px    double precision NOT NULL CHECK (cell_size_px > 0),
  offset_x        double precision NOT NULL DEFAULT 0,
  offset_y        double precision NOT NULL DEFAULT 0,
  rotation_deg    double precision NOT NULL DEFAULT 0 CHECK (rotation_deg BETWEEN -15 AND 15),
  meters_per_cell double precision NOT NULL DEFAULT 1.5 CHECK (meters_per_cell > 0),
  snap_enabled    boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'unconfigured'
                  CHECK (status IN ('unconfigured', 'suggested', 'confirmed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1
);

-- Attori e pedine ------------------------------------------------------------

-- Scheletro creato ora per l'integrità referenziale delle pedine; le librerie
-- complete arrivano con la Milestone 4.
CREATE TABLE actors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind            text NOT NULL DEFAULT 'character' CHECK (kind IN ('character', 'monster')),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  size_in_cells   double precision NOT NULL DEFAULT 1 CHECK (size_in_cells > 0),
  portrait_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  token_asset_id  uuid REFERENCES assets(id) ON DELETE SET NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX actors_campaign_idx ON actors (campaign_id, kind) WHERE deleted_at IS NULL;

CREATE TABLE tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id        uuid NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  actor_id        uuid REFERENCES actors(id) ON DELETE SET NULL,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  x               double precision NOT NULL,
  y               double precision NOT NULL,
  size_in_cells   double precision NOT NULL DEFAULT 1 CHECK (size_in_cells > 0 AND size_in_cells <= 20),
  rotation_deg    double precision NOT NULL DEFAULT 0,
  color           text NOT NULL DEFAULT '#c2410c' CHECK (color ~* '^#[0-9a-f]{6}$'),
  disposition     text NOT NULL DEFAULT 'neutral'
                  CHECK (disposition IN ('friendly', 'neutral', 'hostile')),
  hidden          boolean NOT NULL DEFAULT false,
  image_asset_id  uuid REFERENCES assets(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX tokens_scene_idx ON tokens (scene_id);

-- Difesa in profondità: nessun accesso con le chiavi pubbliche. Il servizio
-- si collega con un ruolo che non è soggetto a RLS; se un giorno una chiave
-- pubblicabile venisse puntata su queste tabelle, non otterrebbe nulla.
ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_state       ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns            ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets               ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_assets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE grid_configurations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE actors               ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokens               ENABLE ROW LEVEL SECURITY;
`;

const INVITES_AND_PLAYERS = `
-- Il nome visualizzato identifica una persona al momento dell'accesso, quindi
-- non può essere ambiguo. Il confronto è senza distinzione di maiuscole.
CREATE UNIQUE INDEX users_display_name_unique ON users (lower(display_name));

CREATE TABLE invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  label        text NOT NULL DEFAULT '',
  max_uses     integer NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 8),
  used_count   integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1,
  CHECK (used_count <= max_uses)
);
CREATE INDEX invites_campaign_idx ON invites (campaign_id) WHERE revoked_at IS NULL;

-- Quali persone controllano quale personaggio.
CREATE TABLE actor_ownership (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (actor_id, user_id)
);
CREATE INDEX actor_ownership_user_idx ON actor_ownership (user_id);

-- Colore della pedina predefinita di un attore, usato quando se ne crea una.
ALTER TABLE actors ADD COLUMN color text NOT NULL DEFAULT '#60a5fa'
  CHECK (color ~* '^#[0-9a-f]{6}$');

-- Registro append-only dei cambiamenti di scena: è la base della
-- sincronizzazione. Ogni evento nasce già con la sua visibilità, così il
-- filtro per ruolo è un dato e non una decisione presa al momento della
-- consegna.
CREATE TABLE scene_events (
  id          bigserial PRIMARY KEY,
  scene_id    uuid NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  payload     jsonb NOT NULL,
  visibility  text NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'game_master')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scene_events_scene_idx ON scene_events (scene_id, id);

ALTER TABLE invites        ENABLE ROW LEVEL SECURITY;
ALTER TABLE actor_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE scene_events   ENABLE ROW LEVEL SECURITY;
`;

export const MIGRATIONS: Migration[] = [
  { name: '0001_init', sql: INIT },
  { name: '0002_invites_and_players', sql: INVITES_AND_PLAYERS },
];

-- 001_init: core schema. Plain SQL, applied in filename order by db migrator (schema_migrations table).
-- Supervisor-owned contract.

CREATE TABLE readings (
  id         BIGSERIAL PRIMARY KEY,
  node_id    TEXT        NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,           -- server receipt time (UTC)
  t          REAL        NOT NULL,
  rh         REAL        NOT NULL,
  light_raw  INTEGER     NOT NULL CHECK (light_raw BETWEEN 0 AND 4095),
  soil_raw   INTEGER     NOT NULL CHECK (soil_raw  BETWEEN 0 AND 4095),
  soil_pct   REAL        NOT NULL CHECK (soil_pct  BETWEEN 0 AND 100),
  light_pct  REAL        NOT NULL CHECK (light_pct BETWEEN 0 AND 100)
);
CREATE INDEX readings_ts_idx      ON readings (ts DESC);
CREATE INDEX readings_node_ts_idx ON readings (node_id, ts DESC);

CREATE TABLE irrigation_events (
  id        BIGSERIAL PRIMARY KEY,
  ts_start  TIMESTAMPTZ NOT NULL,
  ts_end    TIMESTAMPTZ,
  trigger   TEXT NOT NULL CHECK (trigger IN ('auto','manual')),
  reason    TEXT NOT NULL,
  result    TEXT NOT NULL CHECK (result IN ('running','completed','stopped','failed','aborted'))
);
CREATE INDEX irrigation_events_start_idx ON irrigation_events (ts_start DESC);
-- at most one open (running) event
CREATE UNIQUE INDEX irrigation_one_running ON irrigation_events ((result)) WHERE result = 'running';

CREATE TABLE commands (
  id          UUID PRIMARY KEY,                -- idempotency key
  ts          TIMESTAMPTZ NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('pump_on','pump_off','pump_query')),
  state       TEXT NOT NULL CHECK (state IN ('pending','sent','acked','failed','expired')),
  expires_at  TIMESTAMPTZ NOT NULL,
  ack_ts      TIMESTAMPTZ,
  max_s       INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  trigger     TEXT NOT NULL DEFAULT 'auto' CHECK (trigger IN ('auto','manual','recovery')),
  reason      TEXT NOT NULL DEFAULT '',
  last_error  TEXT
);
CREATE INDEX commands_open_idx ON commands (state) WHERE state IN ('pending','sent');
CREATE INDEX commands_ts_idx   ON commands (ts DESC);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alarms (
  code       TEXT PRIMARY KEY,                 -- one row per alarm code
  since      TIMESTAMPTZ NOT NULL,
  message    TEXT NOT NULL,
  severity   TEXT NOT NULL CHECK (severity IN ('warn','critical')),
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  cleared_at TIMESTAMPTZ
);

CREATE TABLE outbox (
  id       BIGSERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind     TEXT NOT NULL,                      -- 'reading' | 'event' | 'alarm' | ...
  payload  JSONB NOT NULL,
  sent_at  TIMESTAMPTZ
);
CREATE INDEX outbox_unsent_idx ON outbox (id) WHERE sent_at IS NULL;

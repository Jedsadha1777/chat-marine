-- ── Entities ──────────────────────────────────────────────────────────────────
-- unit_cost extracted as real column for fast SQL budget filtering (avoids json_extract in WHERE)
CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY,
  uuid        TEXT    UNIQUE NOT NULL,
  entity_type TEXT    NOT NULL,
  code        TEXT    UNIQUE NOT NULL,
  name        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'published',
  unit_cost   REAL    NOT NULL DEFAULT 0,
  attributes  TEXT    NOT NULL DEFAULT '{}'
);

-- Critical index: entity_type + status + unit_cost DESC covers all candidate queries
CREATE INDEX IF NOT EXISTS idx_entities_type_cost
  ON entities (entity_type, status, unit_cost DESC);

-- ============================================================
-- LumHub — Schéma SQLite
-- Version 1.0.0
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- ============================================================
-- SETTINGS — Configuration globale de la box
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Valeurs par défaut
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('box_name',          'Ma LumHub'),
    ('box_serial',        ''),
    ('firmware_version',  '1.0.0'),
    ('zigbee_channel',    '15'),
    ('onboarding_done',   'false'),
    ('timezone',          'Europe/Paris'),
    ('language',          'fr');

-- ============================================================
-- USERS — Comptes utilisateurs
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    NOT NULL UNIQUE,
    email           TEXT    UNIQUE,
    password_hash   TEXT    NOT NULL,
    role            TEXT    NOT NULL DEFAULT 'user' CHECK(role IN ('owner', 'user', 'guest')),
    avatar          TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login      DATETIME
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role     ON users(role);

-- ============================================================
-- SESSIONS — Tokens JWT actifs
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT    NOT NULL UNIQUE,
    device_name TEXT,
    expires_at  DATETIME NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ============================================================
-- ROOMS — Pièces de la maison
-- ============================================================
CREATE TABLE IF NOT EXISTS rooms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    icon        TEXT    NOT NULL DEFAULT 'room',
    floor       INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- DEVICES — Appareils Zigbee
-- ============================================================
CREATE TABLE IF NOT EXISTS devices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ieee_address    TEXT    NOT NULL UNIQUE,
    short_address   TEXT,
    name            TEXT    NOT NULL,
    manufacturer    TEXT,
    model           TEXT,
    profile_id      TEXT,                           -- référence vers le fichier JSON du profil
    type            TEXT    NOT NULL DEFAULT 'unknown',
    room_id         INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    is_online       INTEGER NOT NULL DEFAULT 0,
    is_hidden       INTEGER NOT NULL DEFAULT 0,
    last_seen       DATETIME,
    paired_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_ieee    ON devices(ieee_address);
CREATE INDEX IF NOT EXISTS idx_devices_room    ON devices(room_id);
CREATE INDEX IF NOT EXISTS idx_devices_profile ON devices(profile_id);

-- ============================================================
-- DEVICE_STATES — État actuel de chaque device
-- ============================================================
CREATE TABLE IF NOT EXISTS device_states (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    key         TEXT    NOT NULL,
    value       TEXT,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(device_id, key)
);

CREATE INDEX IF NOT EXISTS idx_device_states_device ON device_states(device_id);

-- ============================================================
-- DEVICE_HISTORY — Historique des états (courbes, stats)
-- ============================================================
CREATE TABLE IF NOT EXISTS device_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    key         TEXT    NOT NULL,
    value       TEXT,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_device_history_device ON device_history(device_id);
CREATE INDEX IF NOT EXISTS idx_device_history_time   ON device_history(recorded_at);
CREATE INDEX IF NOT EXISTS idx_device_history_key    ON device_history(device_id, key, recorded_at);

-- ============================================================
-- SCENES — Groupes d'actions en un tap
-- ============================================================
CREATE TABLE IF NOT EXISTS scenes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    icon        TEXT    NOT NULL DEFAULT 'scene',
    color       TEXT    NOT NULL DEFAULT '#FF6B35',
    created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scene_actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id    INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    action      TEXT    NOT NULL,                   -- JSON : {"key": "state", "value": "on"}
    delay_ms    INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_scene_actions_scene ON scene_actions(scene_id);

-- ============================================================
-- AUTOMATIONS — Scénarios / routines
-- ============================================================
CREATE TABLE IF NOT EXISTS automations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    trigger_type    TEXT    NOT NULL CHECK(trigger_type IN ('time', 'device', 'sunrise', 'sunset', 'manual')),
    trigger_config  TEXT    NOT NULL DEFAULT '{}',  -- JSON
    condition       TEXT,                           -- JSON optionnel (ex: "si température > 22°C")
    created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_triggered  DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS automation_actions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    automation_id   INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    action          TEXT    NOT NULL,               -- JSON : {"key": "pilot_wire_mode", "value": "eco"}
    delay_ms        INTEGER NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_automations_enabled     ON automations(enabled);
CREATE INDEX IF NOT EXISTS idx_automation_actions_auto ON automation_actions(automation_id);

-- ============================================================
-- USER_DEVICE_PERMISSIONS — Accès guests sur devices spécifiques
-- ============================================================
CREATE TABLE IF NOT EXISTS user_device_permissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    can_read    INTEGER NOT NULL DEFAULT 1,
    can_control INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_udp_user   ON user_device_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_udp_device ON user_device_permissions(device_id);

-- ============================================================
-- NOTIFICATIONS — Log des alertes et événements
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = toutes les users
    type        TEXT    NOT NULL CHECK(type IN ('info', 'warning', 'error', 'automation')),
    title       TEXT    NOT NULL,
    body        TEXT,
    is_read     INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(is_read, created_at);

-- ============================================================
-- MIGRATIONS — Versioning du schéma
-- ============================================================
CREATE TABLE IF NOT EXISTS migrations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    version     TEXT    NOT NULL UNIQUE,
    applied_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO migrations (version) VALUES ('1.0.0');

-- ============================================================
-- THERMOSTATS
-- ============================================================
CREATE TABLE IF NOT EXISTS thermostats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id         INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL DEFAULT 'Thermostat',
    enabled         INTEGER NOT NULL DEFAULT 1,
    mode            TEXT    NOT NULL DEFAULT 'manual',
    target_temp     REAL    NOT NULL DEFAULT 19.0,
    away_temp       REAL    NOT NULL DEFAULT 12.0,
    hysteresis      REAL    NOT NULL DEFAULT 0.5,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS thermostat_schedules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    thermostat_id   INTEGER NOT NULL REFERENCES thermostats(id) ON DELETE CASCADE,
    day_of_week     INTEGER NOT NULL,
    time_start      TEXT    NOT NULL,
    time_end        TEXT    NOT NULL,
    target_temp     REAL    NOT NULL,
    label           TEXT
);

CREATE INDEX IF NOT EXISTS idx_thermostat_schedules ON thermostat_schedules(thermostat_id);

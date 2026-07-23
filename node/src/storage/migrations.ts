import { createHash } from "node:crypto";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

function migration(version: number, name: string, sql: string): Migration {
  return {
    version,
    name,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
}

export const migrations: readonly Migration[] = [
  migration(1, "single_node_foundation", `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT,
      user_id TEXT,
      team_id TEXT,
      payload_json TEXT NOT NULL,
      expires_at INTEGER,
      row_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
    CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);

    CREATE TABLE IF NOT EXISTS account_pool (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      weight INTEGER NOT NULL DEFAULT 1 CHECK(weight >= 0),
      disabled_for_quota INTEGER NOT NULL DEFAULT 0 CHECK(disabled_for_quota IN (0, 1)),
      disabled_reason TEXT,
      quota_disabled_at INTEGER,
      quota_source TEXT,
      last_quota_json TEXT NOT NULL DEFAULT '{}',
      last_probe_json TEXT NOT NULL DEFAULT '{}',
      blocked_models_json TEXT NOT NULL DEFAULT '{}',
      request_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      last_error TEXT,
      cooldown_until INTEGER,
      pool_status TEXT NOT NULL DEFAULT 'normal',
      sso_reauth_failed_at INTEGER,
      sso_reauth_next_at INTEGER,
      sso_reauth_error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_account_pool_eligible
      ON account_pool(enabled, disabled_for_quota, cooldown_until);
    CREATE INDEX IF NOT EXISTS idx_account_pool_sso_reauth
      ON account_pool(sso_reauth_next_at);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      request_count INTEGER NOT NULL DEFAULT 0,
      prompt_tokens_total INTEGER NOT NULL DEFAULT 0,
      completion_tokens_total INTEGER NOT NULL DEFAULT 0,
      total_tokens_total INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      owned_by TEXT NOT NULL DEFAULT 'xai',
      hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0, 1)),
      synthetic INTEGER NOT NULL DEFAULT 0 CHECK(synthetic IN (0, 1)),
      context_window INTEGER,
      supports_reasoning_effort INTEGER,
      extra_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 100,
      fetched_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'leased', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled')),
      idempotency_key TEXT NOT NULL UNIQUE,
      request_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_automation_tasks_claim
      ON automation_tasks(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_tasks_lease
      ON automation_tasks(status, lease_expires_at);

    CREATE TABLE IF NOT EXISTS automation_task_events (
      id INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES automation_tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_task_events_task
      ON automation_task_events(task_id, id);
  `),
  migration(2, "account_maintenance_state", `
    ALTER TABLE account_pool ADD COLUMN last_renew_status TEXT;
    ALTER TABLE account_pool ADD COLUMN last_renew_at INTEGER;
    ALTER TABLE account_pool ADD COLUMN renew_fail_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE account_pool ADD COLUMN sso_reauth_attempted_at INTEGER;
    CREATE INDEX IF NOT EXISTS idx_accounts_expires_at ON accounts(expires_at);
  `),
  migration(3, "device_login_sessions", `
    CREATE TABLE IF NOT EXISTS device_login_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('waiting_user', 'running', 'succeeded', 'failed', 'expired')),
      device_code TEXT NOT NULL,
      user_code TEXT NOT NULL,
      verification_url TEXT NOT NULL,
      client_id TEXT NOT NULL,
      polling_interval_ms INTEGER NOT NULL,
      target_account_id TEXT,
      account_id TEXT,
      email TEXT,
      message TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_device_login_sessions_active
      ON device_login_sessions(status, expires_at);
  `),
  migration(4, "account_pool_extra_snapshot", `
    ALTER TABLE account_pool ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}';
  `),
  migration(5, "single_node_usage_telemetry", `
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      api_key_id TEXT,
      account_id TEXT,
      model TEXT NOT NULL,
      protocol TEXT NOT NULL,
      success INTEGER NOT NULL CHECK(success IN (0, 1)),
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON usage_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_api_key ON usage_events(api_key_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_account ON usage_events(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model, created_at DESC);

    CREATE TABLE IF NOT EXISTS usage_daily (
      day TEXT NOT NULL,
      dim TEXT NOT NULL,
      dim_id TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 0,
      fail INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, dim, dim_id)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_daily_dim_day ON usage_daily(dim, day DESC);
  `),
  migration(6, "legacy_operational_history", `
    CREATE TABLE IF NOT EXISTS legacy_history (
      source_table TEXT NOT NULL,
      legacy_id TEXT NOT NULL,
      created_at INTEGER,
      payload_json TEXT NOT NULL,
      PRIMARY KEY(source_table, legacy_id)
    );
    CREATE INDEX IF NOT EXISTS idx_legacy_history_source_created
      ON legacy_history(source_table, created_at DESC);
  `),
  migration(7, "revealable_api_keys", `
    ALTER TABLE api_keys ADD COLUMN secret_value TEXT;
  `),
];

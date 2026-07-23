import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  exportLegacyPostgresSnapshot,
  type PostgresSnapshotSource,
  writePrivateSnapshot,
} from "../src/migration/legacy-postgres-export.js";
import { importLegacySnapshot, type LegacySnapshot } from "../src/migration/legacy-snapshot-import.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

class FakePostgresSource implements PostgresSnapshotSource {
  async query<T extends Record<string, unknown>>(sql: string): Promise<{ readonly rows: readonly T[] }> {
    if (sql.includes("FROM accounts a")) {
      return rows<T>([
        {
          id: "account-1",
          email: "member@example.test",
          user_id: "user-1",
          team_id: "team-1",
          payload: { access_token: "test-access", refresh_token: "test-refresh" },
          expires_at: 1_800_000_000,
          enabled: true,
          weight: 4,
          disabled_for_quota: false,
          disabled_reason: null,
          quota_disabled_at: null,
          quota_source: null,
          last_quota: { remaining: 42 },
          last_probe: {},
          blocked_models: { "grok-4": 1_800_000_001 },
          request_count: 3,
          success_count: 2,
          fail_count: 1,
          last_used_at: 1_700_000_000,
          last_error: null,
          cooldown_until: null,
          pool_status: "normal",
          extra: { source: "legacy" },
        },
      ]);
    }
    if (sql.includes("FROM api_keys")) {
      return rows<T>([
        {
          id: "key-1",
          name: "migration key",
          prefix: "sk-g2a-test",
          key_hash: "0".repeat(64),
          enabled: true,
          note: "test only",
          created_at: 1_700_000_000,
          last_used_at: null,
          request_count: 3,
          prompt_tokens_total: 4,
          completion_tokens_total: 5,
          total_tokens_total: 9,
        },
      ]);
    }
    if (sql.includes("FROM models")) {
      return rows<T>([
        {
          id: "grok-4",
          name: "Grok 4",
          description: "test model",
          owned_by: "xai",
          hidden: false,
          synthetic: false,
          context_window: 131_072,
          supports_reasoning_effort: true,
          extra: { tier: "test" },
          sort_order: 10,
          fetched_at: 1_700_000_010,
        },
      ]);
    }
    if (sql.includes("FROM app_settings")) {
      return rows<T>([
        { key: "models_meta", value: { source: "legacy" } },
        { key: "cliproxyapi_config", value: { url: "https://not-migrated.example.test" } },
      ]);
    }
    if (sql.includes("FROM usage_events")) {
      return rows<T>([
        {
          id: "7",
          request_id: null,
          api_key_id: "key-1",
          account_id: "account-1",
          model: "grok-4",
          protocol: "chat_completions",
          ok: true,
          prompt_tokens: "4",
          completion_tokens: "5",
          total_tokens: "9",
          cache_read_tokens: "1",
          created_at: 1_700_000_020,
        },
      ]);
    }
    if (sql.includes("FROM usage_daily")) {
      return rows<T>([
        {
          day: "2023-11-14",
          dim: "global",
          dim_id: "",
          requests: "1",
          success: "1",
          fail: "0",
          prompt_tokens: "4",
          completion_tokens: "5",
          total_tokens: "9",
        },
      ]);
    }
    if (sql.includes("FROM task_logs")) {
      return rows<T>([
        { id: "3", created_at: 1_700_000_030, updated_at: 1_700_000_031, finished_at: null, kind: "refresh", task_id: "task-1", status: "succeeded", summary: "done", detail: { safe: true }, ok: true, progress_done: 1, progress_total: 1 },
      ]);
    }
    if (sql.includes("FROM admin_audit_logs")) {
      return rows<T>([
        { id: "5", created_at: 1_700_000_040, actor: "admin", action: "account.refresh", target_type: "account", target_id: "account-1", summary: "done", detail: { safe: true }, ip: "127.0.0.1", user_agent: "test", ok: true },
      ]);
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

function rows<T extends Record<string, unknown>>(values: readonly Record<string, unknown>[]): { readonly rows: readonly T[] } {
  return { rows: values as unknown as readonly T[] };
}

test("PostgreSQL exporter creates an importable, secret-silent snapshot", async () => {
  const exported = await exportLegacyPostgresSnapshot(new FakePostgresSource());
  const snapshot = exported.snapshot as {
    readonly schema_version: number;
    readonly accounts: readonly Record<string, unknown>[];
    readonly account_pool: readonly Record<string, unknown>[];
    readonly api_keys: readonly Record<string, unknown>[];
    readonly settings: Record<string, unknown>;
    readonly history: { usage_events: readonly Record<string, unknown>[]; task_logs: readonly Record<string, unknown>[]; admin_audit_logs: readonly Record<string, unknown>[] };
  };
  assert.equal(snapshot.schema_version, 1);
  assert.equal(exported.report.accounts, 1);
  assert.equal(exported.report.pools, 1);
  assert.equal(exported.report.apiKeys, 1);
  assert.equal(exported.report.usageEvents, 1);
  assert.equal(exported.report.usageDaily, 1);
  assert.equal(exported.report.taskLogs, 1);
  assert.equal(exported.report.auditLogs, 1);
  assert.equal(exported.report.skippedUnsupportedSettings, 1);
  assert.match(exported.report.inventorySha256, /^[a-f0-9]{64}$/);
  assert.match(exported.report.credentialsSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.account_pool[0]?.extra, { source: "legacy" });
  assert.equal(snapshot.api_keys[0]?.key_hash, "0".repeat(64));
  assert.deepEqual(snapshot.settings, { models_meta: { source: "legacy" } });
  assert.equal(snapshot.history.usage_events[0]?.request_id, null);
  assert.equal(snapshot.history.task_logs[0]?.id, "3");
  assert.equal(snapshot.history.admin_audit_logs[0]?.id, "5");

  const directory = mkdtempSync(join(tmpdir(), "grok2api-export-import-checksum-test-"));
  const store = new SqliteStore(join(directory, "app.sqlite"));
  try {
    store.migrate();
    const imported = importLegacySnapshot(store, exported.snapshot as unknown as LegacySnapshot);
    assert.equal(imported.inventorySha256, exported.report.inventorySha256);
    assert.equal(imported.credentialsSha256, exported.report.credentialsSha256);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("private snapshots are atomically written without emitting their content", () => {
  const directory = mkdtempSync(join(tmpdir(), "grok2api-export-test-"));
  const output = join(directory, "snapshot.json");
  try {
    writePrivateSnapshot(output, { schema_version: 1, accounts: [] });
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { schema_version: 1, accounts: [] });
    if (process.platform !== "win32") {
      assert.equal(statSync(output).mode & 0o777, 0o640);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  exportLegacyPostgresSnapshot,
  type PostgresSnapshotSource,
  writePrivateSnapshot,
} from "../src/migration/legacy-postgres-export.js";

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
  };
  assert.equal(snapshot.schema_version, 1);
  assert.equal(exported.report.accounts, 1);
  assert.equal(exported.report.pools, 1);
  assert.equal(exported.report.apiKeys, 1);
  assert.equal(exported.report.skippedUnsupportedSettings, 1);
  assert.match(exported.report.inventorySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.account_pool[0]?.extra, { source: "legacy" });
  assert.equal(snapshot.api_keys[0]?.key_hash, "0".repeat(64));
  assert.deepEqual(snapshot.settings, { models_meta: { source: "legacy" } });
});

test("private snapshots are atomically written without emitting their content", () => {
  const directory = mkdtempSync(join(tmpdir(), "grok2api-export-test-"));
  const output = join(directory, "snapshot.json");
  try {
    writePrivateSnapshot(output, { schema_version: 1, accounts: [] });
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { schema_version: 1, accounts: [] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

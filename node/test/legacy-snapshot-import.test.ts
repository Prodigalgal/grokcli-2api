import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { requireApiKey } from "../src/auth/api-key-auth.js";
import { importLegacySnapshot, type LegacySnapshot } from "../src/migration/legacy-snapshot-import.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

function createStore(): { readonly store: SqliteStore; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-snapshot-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  return { store, dir };
}

test("legacy snapshot imports account pool, API key hashes, models, and settings atomically", () => {
  const { store, dir } = createStore();
  try {
    const apiKey = "snapshot-api-key";
    const snapshot: LegacySnapshot = {
      schema_version: 1,
      source: "test-snapshot",
      accounts: [{
        id: "account-1",
        email: "member@example.test",
        user_id: "user-1",
        expires_at: 1_800_000_000,
        payload: { key: "access-token", refresh_token: "refresh-token" },
      }],
      account_pool: [{
        account_id: "account-1",
        enabled: false,
        weight: 3,
        request_count: 7,
        blocked_models: { "grok-4.5": 1_900_000_000 },
        pool_status: "disabled",
      }],
      api_keys: [{
        id: "key-1",
        name: "snapshot key",
        prefix: "sk-g2a-snap",
        key_hash: createHash("sha256").update(apiKey).digest("hex"),
        enabled: true,
        created_at: 1_700_000_000,
        request_count: 11,
      }],
      models: [{
        id: "grok-4.5",
        name: "Grok 4.5",
        owned_by: "xai",
        hidden: false,
        synthetic: false,
        context_window: 131_072,
        supports_reasoning_effort: true,
        extra: { supported_in_api: true },
        sort_order: 10,
      }],
      settings: {
        registration_config: { mail_provider: "cfmail" },
        models_meta: { source: "snapshot" },
        sub2api_config: { url: "https://not-migrated.example.test" },
      },
    };
    const report = importLegacySnapshot(store, snapshot, 1_700_000_001_000);
    assert.equal(report.accounts, 1);
    assert.equal(report.pools, 1);
    assert.equal(report.apiKeys, 1);
    assert.equal(report.models, 1);
    assert.equal(report.skippedUnsupportedSettings, 1);
    assert.equal(store.getAccount("account-1")?.email, "member@example.test");
    assert.equal(store.listPoolCandidates().length, 1);
    assert.equal(store.listPoolCandidates()[0]?.enabled, false);
    assert.equal(requireApiKey({ authorization: `Bearer ${apiKey}` }, { legacyApiKey: null, requireApiKey: "on" }, store).ok, true);
    assert.equal(store.listPublicModels()[0]?.id, "grok-4.5");
    assert.deepEqual(store.getSetting("registration_config"), { mail_provider: "cfmail" });
    assert.equal(store.getSetting("sub2api_config"), null);
    assert.match(report.inventorySha256, /^[a-f0-9]{64}$/);
    assert.match(report.credentialsSha256, /^[a-f0-9]{64}$/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy snapshot rejects a pool reference that does not belong to an imported account", () => {
  const { store, dir } = createStore();
  try {
    const snapshot: LegacySnapshot = {
      schema_version: 1,
      accounts: [{ id: "account-1", payload: { key: "token" } }],
      account_pool: [{ account_id: "missing-account" }],
    };
    assert.throws(() => importLegacySnapshot(store, snapshot), /unknown account/);
    assert.equal(store.countAccounts(), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

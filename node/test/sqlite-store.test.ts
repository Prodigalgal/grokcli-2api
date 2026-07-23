import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteStore } from "../src/storage/sqlite-store.js";

function createStore(): { readonly store: SqliteStore; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-node-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate(1_700_000_000_000);
  return { store, dir };
}

test("SQLite migrations and account writes are durable", () => {
  const { store, dir } = createStore();
  try {
    assert.deepEqual(store.listAppliedMigrations(), [1, 2, 3, 4, 5, 6]);
    const first = store.saveAccount({
      id: "account-1",
      email: "user@example.test",
      userId: "user-1",
      payload: { access_token: "new-token", refresh_token: "refresh-token" },
    }, 1_700_000_000_100);
    assert.equal(first.rowVersion, 1);
    assert.deepEqual(first.payload, { access_token: "new-token", refresh_token: "refresh-token" });

    const refreshed = store.saveAccount({
      id: "account-1",
      email: "user@example.test",
      userId: "user-1",
      payload: { access_token: "replacement", refresh_token: "replacement-refresh" },
    }, 1_700_000_000_200);
    assert.equal(refreshed.rowVersion, 2);
    assert.equal(refreshed.payload.access_token, "replacement");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

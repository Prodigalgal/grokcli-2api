import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { importLegacyAuthExport } from "../src/migration/legacy-auth-import.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

test("legacy auth import preserves credential payload and identity metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-import-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  try {
    store.migrate();
    const report = importLegacyAuthExport(store, {
      source: "grokcli-2api",
      auth: {
        "https://auth.x.ai::user-1": {
          email: "user@example.test",
          user_id: "user-1",
          team_id: "team-1",
          access_token: "secret-access-token",
          refresh_token: "secret-refresh-token",
          sso: "secret-sso-cookie",
          expires_at: 1_700_000_000,
        },
      },
    }, 1_700_000_001_000);
    assert.equal(report.imported, 1);
    assert.equal(report.totalAccounts, 1);
    assert.match(report.inventorySha256, /^[a-f0-9]{64}$/);
    assert.match(report.credentialsSha256, /^[a-f0-9]{64}$/);

    const account = store.getAccount("https://auth.x.ai::user-1");
    assert.equal(account?.email, "user@example.test");
    assert.equal(account?.expiresAt, 1_700_000_000_000);
    assert.equal(account?.payload.refresh_token, "secret-refresh-token");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

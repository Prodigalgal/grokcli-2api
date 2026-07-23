import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OidcRefreshClient } from "../src/maintainer/oidc-refresh.js";
import { TokenMaintainer } from "../src/maintainer/service.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

function createStore(): { readonly store: SqliteStore; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-maintainer-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  return { store, dir };
}

function config() {
  return {
    tokenMaintainerIntervalMs: 60_000,
    tokenRefreshBatch: 40,
    tokenRefreshWorkers: 2,
    tokenRefreshSkewMs: 60_000,
    oidcTokenUrl: "https://auth.example.test/oauth2/token",
    oidcClientId: "grok-cli",
  };
}

test("token maintainer refreshes expiring tokens and clears failure state", async () => {
  const { store, dir } = createStore();
  try {
    store.saveAccount({
      id: "account-refresh",
      email: "account@example.test",
      userId: "user-refresh",
      payload: { key: "old-access", access_token: "old-access", refresh_token: "refresh-old", refresh_invalid: true },
      expiresAt: Date.now() + 1_000,
    });
    const client = new OidcRefreshClient({
      tokenUrl: config().oidcTokenUrl,
      clientId: config().oidcClientId,
      fetchImpl: async (_input, init) => {
        assert.equal(init?.method, "POST");
        assert.match(String(init?.body), /grant_type=refresh_token/);
        assert.match(String(init?.body), /client_id=grok-cli/);
        return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-new", expires_in: 3_600 }), { status: 200 });
      },
    });
    // Clear the legacy marker so this account is eligible for a real refresh attempt.
    store.saveAccount({
      id: "account-refresh",
      email: "account@example.test",
      userId: "user-refresh",
      payload: { key: "old-access", access_token: "old-access", refresh_token: "refresh-old" },
      expiresAt: Date.now() + 1_000,
    });
    const result = await new TokenMaintainer({ store, config: config(), oidcClient: client }).runOnce();
    assert.deepEqual(result, { attempted: 1, refreshed: 1, failed: 0, permanentFailures: 0, ssoTasksQueued: 0 });
    const refreshed = store.getAccount("account-refresh");
    assert.equal(refreshed?.payload.key, "new-access");
    assert.equal(refreshed?.payload.access_token, "new-access");
    assert.equal(refreshed?.payload.refresh_token, "refresh-new");
    assert.equal(refreshed?.payload.refresh_invalid, undefined);
    assert.ok((refreshed?.expiresAt ?? 0) > Date.now() + 3_500_000);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("permanent refresh failure queues an idempotent SSO reauthentication task", async () => {
  const { store, dir } = createStore();
  try {
    const now = Date.now();
    store.saveAccount({
      id: "account-sso",
      payload: { key: "old-access", refresh_token: "refresh-old", sso_cookie: "test-sso-cookie" },
      expiresAt: now + 1_000,
    });
    store.saveAccount({
      id: "account-no-sso",
      payload: { key: "old-access", refresh_token: "refresh-old" },
      expiresAt: now + 1_000,
    });
    const client = new OidcRefreshClient({
      tokenUrl: config().oidcTokenUrl,
      clientId: config().oidcClientId,
      fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    });
    const result = await new TokenMaintainer({ store, config: config(), oidcClient: client }).runOnce();
    assert.deepEqual(result, { attempted: 2, refreshed: 0, failed: 2, permanentFailures: 2, ssoTasksQueued: 1 });
    const ssoAccount = store.getAccount("account-sso");
    assert.equal(ssoAccount?.payload.refresh_invalid, true);
    const invalidAt = ssoAccount?.payload.refresh_invalid_at;
    assert.equal(typeof invalidAt, "number");
    const task = store.getAutomationTaskByIdempotencyKey(`sso_reauth:account-sso:${invalidAt}`);
    assert.equal(task?.kind, "sso_reauth");
    assert.equal(task?.status, "queued");
    assert.deepEqual(task?.request, { accountId: "account-sso", trigger: "refresh_token_invalid" });
    assert.equal(store.getAutomationTaskByIdempotencyKey(`sso_reauth:account-no-sso:${invalidAt}`), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

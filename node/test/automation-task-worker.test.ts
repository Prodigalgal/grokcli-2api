import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeviceLoginService } from "../src/auth/device-login-service.js";
import { AutomationTaskWorker } from "../src/automation/task-worker.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

function createStore(): { readonly store: SqliteStore; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-task-worker-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  return { store, dir };
}

const oidcConfig = {
  oidcDeviceUrl: "https://auth.example.test/oauth2/device/code",
  oidcTokenUrl: "https://auth.example.test/oauth2/token",
  oidcClientId: "test-client",
  oidcScopes: "openid offline_access",
};

test("failed SSO task falls back to device login and completes after authorization", async () => {
  const { store, dir } = createStore();
  try {
    store.saveAccount({
      id: "account-sso-recover",
      payload: { key: "expired", refresh_token: "refresh", sso_cookie: "expired-sso", refresh_invalid: true },
      expiresAt: Date.now() - 1_000,
    });
    const task = store.automationTasks().enqueue("sso_reauth", "sso_reauth:account-sso-recover:1", {
      accountId: "account-sso-recover",
    });
    let requestCount = 0;
    const deviceLogins = new DeviceLoginService({
      store,
      config: oidcConfig,
      autoPoll: false,
      fetchImpl: async () => {
        requestCount += 1;
        return requestCount === 1
          ? new Response(JSON.stringify({ device_code: "private-code", user_code: "AB-12", verification_uri: "https://verify.example.test", expires_in: 600 }), { status: 200 })
          : new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3_600 }), { status: 200 });
      },
    });
    const worker = new AutomationTaskWorker({
      store,
      deviceLogins,
      ssoReauth: { reauthenticate: async () => { throw new Error("saved SSO cookie is no longer valid"); } },
      browserRunner: { run: async () => ({}) },
      config: { workerLeaseMs: 10_000, ssoReauthCooldownMs: 3_600_000 },
      owner: "test-worker",
    });

    await worker.runOnce();
    const waiting = store.automationTasks().get(task.id);
    assert.equal(waiting?.status, "waiting_input");
    assert.equal(waiting?.result?.recovery, "device_login");
    assert.equal(waiting?.result?.userCode, "AB-12");
    assert.equal(JSON.stringify(waiting).includes("private-code"), false);

    const sessionId = waiting?.result?.deviceLoginSessionId;
    assert.equal(typeof sessionId, "string");
    await deviceLogins.pollOnce(sessionId as string);
    await worker.runOnce();
    const completed = store.automationTasks().get(task.id);
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.result?.recoveredBy, "device_login");
    assert.equal(store.getAccount("account-sso-recover")?.payload.key, "fresh-access");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

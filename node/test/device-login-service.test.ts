import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeviceLoginService } from "../src/auth/device-login-service.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

function createStore(): { readonly store: SqliteStore; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-device-login-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  return { store, dir };
}

const config = {
  oidcDeviceUrl: "https://auth.example.test/oauth2/device/code",
  oidcTokenUrl: "https://auth.example.test/oauth2/token",
  oidcClientId: "test-client",
  oidcScopes: "openid offline_access",
};

test("device login restores an invalid account without exposing device_code", async () => {
  const { store, dir } = createStore();
  try {
    store.saveAccount({
      id: "account-invalid",
      email: "member@example.test",
      userId: "member-1",
      payload: {
        key: "old-access",
        refresh_token: "old-refresh",
        sso_cookie: "saved-sso-context",
        refresh_invalid: true,
      },
      expiresAt: Date.now() - 1_000,
    });
    const forms: string[] = [];
    const service = new DeviceLoginService({
      store,
      config,
      autoPoll: false,
      fetchImpl: async (_input, init) => {
        forms.push(String(init?.body));
        if (forms.length === 1) {
          return new Response(JSON.stringify({
            device_code: "private-device-code",
            user_code: "ab-cd-12",
            verification_uri_complete: "https://verify.example.test/?code=AB-CD-12",
            interval: 3,
            expires_in: 600,
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          access_token: "replacement-access",
          refresh_token: "replacement-refresh",
          expires_in: 3_600,
          email: "member@example.test",
        }), { status: 200 });
      },
    });
    const started = await service.start("account-invalid");
    assert.equal(started.status, "waiting_user");
    assert.equal(started.userCode, "AB-CD-12");
    assert.equal(JSON.stringify(started).includes("private-device-code"), false);
    assert.match(forms[0]!, /client_id=test-client/);

    const completed = await service.pollOnce(started.id);
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.accountId, "account-invalid");
    assert.match(forms[1]!, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
    const account = store.getAccount("account-invalid");
    assert.equal(account?.payload.key, "replacement-access");
    assert.equal(account?.payload.refresh_token, "replacement-refresh");
    assert.equal(account?.payload.sso_cookie, "saved-sso-context");
    assert.equal(account?.payload.refresh_invalid, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

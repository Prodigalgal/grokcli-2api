import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApiServer } from "../src/http/health-server.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

test("SQLite admin management requires both credentials and exposes revealable API keys", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grok2api-admin-management-test-"));
  const store = new SqliteStore(join(directory, "app.sqlite"));
  store.migrate();
  store.saveAccount({
    id: "account-1",
    email: "member@example.test",
    userId: "user-1",
    payload: { access_token: "private-access-token", refresh_token: "private-refresh-token" },
    expiresAt: Date.now() + 3_600_000,
  });
  const server = createApiServer({
    adminStore: store,
    modelStore: store,
    apiKeyStore: store,
    adminUsername: "admin-test-user",
    adminPassword: "admin-test-password",
  });
  const port = await server.listen("127.0.0.1", 0);
  const adminHeaders = { "x-admin-username": "admin-test-user", "x-admin-password": "admin-test-password" };
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/admin/api/status`);
    assert.equal(denied.status, 401);
    const wrongUser = await fetch(`http://127.0.0.1:${port}/admin/api/status`, { headers: { "x-admin-username": "wrong", "x-admin-password": "admin-test-password" } });
    assert.equal(wrongUser.status, 401);

    const status = await fetch(`http://127.0.0.1:${port}/admin/api/status`, { headers: adminHeaders });
    assert.equal(status.status, 200);
    const statusBody = await status.json() as { store: { backend: string; redis: boolean; postgresql: boolean }; accounts: { account_count: number } };
    assert.deepEqual(statusBody.store, { backend: "sqlite", redis: false, postgresql: false });
    assert.equal(statusBody.accounts.account_count, 1);

    const accounts = await fetch(`http://127.0.0.1:${port}/admin/api/accounts?q=member`, { headers: adminHeaders });
    assert.equal(accounts.status, 200);
    const accountsText = await accounts.text();
    assert.match(accountsText, /member@example\.test/);
    assert.equal(accountsText.includes("private-access-token"), false);
    assert.equal(accountsText.includes("private-refresh-token"), false);
    assert.match(accountsText, /"hasEmailMailbox":false/);

    const disabled = await fetch(`http://127.0.0.1:${port}/admin/api/accounts/account-1/enabled`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json() as { account: { enabled: boolean } }).account.enabled, false);

    const created = await fetch(`http://127.0.0.1:${port}/admin/api/keys`, {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "automation" }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { key: { id: string; prefix: string }; secret: string };
    assert.equal(createdBody.secret.startsWith(createdBody.key.prefix), true);

    const keyList = await fetch(`http://127.0.0.1:${port}/admin/api/keys`, { headers: adminHeaders });
    assert.equal(keyList.status, 200);
    assert.equal((await keyList.text()).includes(createdBody.secret), true);

    const authorizedModels = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${createdBody.secret}` },
    });
    assert.equal(authorizedModels.status, 200);

    const rotated = await fetch(`http://127.0.0.1:${port}/admin/api/keys/${createdBody.key.id}/regenerate`, {
      method: "POST",
      headers: adminHeaders,
    });
    assert.equal(rotated.status, 200);
    const rotatedBody = await rotated.json() as { secret: string };
    assert.notEqual(rotatedBody.secret, createdBody.secret);
    const oldKey = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${createdBody.secret}` } });
    assert.equal(oldKey.status, 401);
    const newKey = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${rotatedBody.secret}` } });
    assert.equal(newKey.status, 200);
    const rotatedList = await fetch(`http://127.0.0.1:${port}/admin/api/keys`, { headers: adminHeaders });
    assert.equal((await rotatedList.text()).includes(rotatedBody.secret), true);
  } finally {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

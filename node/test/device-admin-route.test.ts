import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeviceLoginService } from "../src/auth/device-login-service.js";
import { createApiServer } from "../src/http/health-server.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

test("device login admin routes require the admin password and redact device_code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-device-route-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  const deviceLogins = new DeviceLoginService({
    store,
    autoPoll: false,
    config: {
      oidcDeviceUrl: "https://auth.example.test/oauth2/device/code",
      oidcTokenUrl: "https://auth.example.test/oauth2/token",
      oidcClientId: "test-client",
      oidcScopes: "openid offline_access",
    },
    fetchImpl: async () => new Response(JSON.stringify({
      device_code: "private-device-code",
      user_code: "AB-12",
      verification_uri: "https://verify.example.test",
      expires_in: 600,
    }), { status: 200 }),
  });
  store.saveAccount({ id: "account-email-login", email: "member@example.test", payload: { access_token: "private-access" } });
  store.saveCloudflareMailboxCredential("account-email-login", {
    id: "mailbox-1",
    address: "member@example.test",
    accessToken: "private-mailbox-jwt",
  });
  const server = createApiServer({
    deviceLogins,
    automationTasks: store.automationTasks(),
    adminStore: store,
    adminPassword: "admin-test-password",
  });
  const port = await server.listen("127.0.0.1", 0);
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/admin/api/device/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(denied.status, 401);

    const started = await fetch(`http://127.0.0.1:${port}/admin/api/device/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-password": "admin-test-password" },
      body: JSON.stringify({ account_id: "account-1" }),
    });
    assert.equal(started.status, 200);
    const startedBody = await started.json() as { ok: boolean; session: { id: string; userCode: string } };
    assert.equal(startedBody.ok, true);
    assert.equal(startedBody.session.userCode, "AB-12");
    assert.equal(JSON.stringify(startedBody).includes("private-device-code"), false);

    const listed = await fetch(`http://127.0.0.1:${port}/admin/api/device/sessions`, {
      headers: { "x-admin-password": "admin-test-password" },
    });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json() as { count: number }).count, 1);

    const registration = await fetch(`http://127.0.0.1:${port}/admin/api/accounts/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-password": "admin-test-password" },
      body: JSON.stringify({
        idempotency_key: "registration-test",
        mailbox: { domain: "mail.example.test" },
        browser: { url: "https://register.example.test", actions: [{ type: "fill", selector: "#email", value: "private@example.test" }] },
      }),
    });
    assert.equal(registration.status, 202);
    const registrationBody = await registration.json() as { tasks: Array<{ id: string; kind: string }> };
    const registrationTask = registrationBody.tasks[0]!;
    assert.equal(registrationTask.kind, "registration");
    assert.equal(JSON.stringify(registrationBody).includes("private@example.test"), false);
    assert.deepEqual(store.automationTasks().get(registrationTask.id)?.request.mailbox, {});
    const taskStatus = await fetch(`http://127.0.0.1:${port}/admin/api/automation/tasks/${registrationTask.id}`, {
      headers: { "x-admin-password": "admin-test-password" },
    });
    assert.equal(taskStatus.status, 200);
    assert.equal(JSON.stringify(await taskStatus.json()).includes("private@example.test"), false);

    const taskList = await fetch(`http://127.0.0.1:${port}/admin/api/automation/tasks?status=queued`, {
      headers: { "x-admin-password": "admin-test-password" },
    });
    assert.equal(taskList.status, 200);
    assert.equal((await taskList.json() as { count: number }).count, 1);
    const cancelled = await fetch(`http://127.0.0.1:${port}/admin/api/automation/tasks/${registrationTask.id}/cancel`, {
      method: "POST",
      headers: { "x-admin-password": "admin-test-password" },
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { task: { status: string } }).task.status, "cancelled");

    const emailLogin = await fetch(`http://127.0.0.1:${port}/admin/api/accounts/account-email-login/email-login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-password": "admin-test-password" },
      body: JSON.stringify({
        browser: { url: "https://accounts.example.test/sign-in", actions: [{ type: "fill", selector: "#email", value: "{{account.email}}" }] },
      }),
    });
    assert.equal(emailLogin.status, 202);
    assert.equal(JSON.stringify(await emailLogin.json()).includes("private-mailbox-jwt"), false);
  } finally {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

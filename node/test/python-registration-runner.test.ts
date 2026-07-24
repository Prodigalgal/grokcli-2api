import assert from "node:assert/strict";
import test from "node:test";

import { PythonRegistrationTaskRunner } from "../src/registration/python-registration-runner.js";

test("Python registration worker returns SSO to Node over direct egress", async () => {
  let savedMailbox: Record<string, unknown> | null = null;
  const runner = new PythonRegistrationTaskRunner({
    serviceUrl: "http://127.0.0.1:18070",
    token: "worker-token",
    timeoutMs: 60_000,
    cfMailBaseUrl: "https://mail.example.test",
    cfMailAdminPassword: "mail-admin-password",
    cfMailDomain: "mail.example.test",
    ssoConverter: {
      async registerFromSsoCookie(sso, email, token) {
        assert.equal(sso, "private-sso");
        assert.equal(email, "new@mail.example.test");
        assert.equal(token?.access_token, "private-access-token");
        return { accountId: "account-1", email };
      },
    },
    mailboxStore: {
      saveCloudflareMailboxCredential(accountId, mailbox) {
        savedMailbox = { accountId, ...mailbox };
      },
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer worker-token");
      if (url.endsWith("/internal/registration/v1/jobs")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.proxy, "");
        assert.equal(body.count, 1);
        assert.equal(body.concurrency, 1);
        return Response.json({ id: "session-1", status: "queued" });
      }
      if (url.includes("/sessions/session-1?include_auth_json=1")) {
        return Response.json({
          id: "session-1",
          status: "completed",
          auth_json: {
            external_registration: {
              sso: "private-sso",
              token: { access_token: "private-access-token", refresh_token: "private-refresh-token" },
              email: "new@mail.example.test",
              mailbox: { id: "mailbox-1", address: "new@mail.example.test", access_token: "private-mailbox-token" },
            },
          },
        });
      }
      throw new Error(`unexpected registration worker request ${url}`);
    },
  });

  const result = await runner.run({ mailbox: { domain: "mail.example.test" } });
  assert.deepEqual(result, {
    accountId: "account-1",
    email: "new@mail.example.test",
    mailProvider: "cloudflare_temp_mail",
    executor: "python_registration_worker",
  });
  assert.deepEqual(savedMailbox, {
    accountId: "account-1",
    id: "mailbox-1",
    address: "new@mail.example.test",
    accessToken: "private-mailbox-token",
  });
});

test("Python registration worker stops a failed direct session", async () => {
  let stopped = 0;
  const runner = new PythonRegistrationTaskRunner({
    serviceUrl: "http://127.0.0.1:18070",
    token: null,
    timeoutMs: 60_000,
    cfMailBaseUrl: "https://mail.example.test",
    cfMailAdminPassword: "mail-admin-password",
    cfMailDomain: "mail.example.test",
    ssoConverter: {
      async registerFromSsoCookie() {
        throw new Error("unexpected SSO conversion");
      },
    },
    mailboxStore: { saveCloudflareMailboxCredential() {} },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/internal/registration/v1/jobs")) {
        return Response.json({ id: "session-failed", status: "queued" });
      }
      if (url.includes("/sessions/session-failed?include_auth_json=1")) {
        return Response.json({ status: "failed", error: "captcha rejected" });
      }
      if (url.endsWith("/sessions/session-failed/stop")) {
        stopped += 1;
        return Response.json({ status: "stopped" });
      }
      throw new Error(`unexpected registration worker request ${url}`);
    },
  });

  await assert.rejects(() => runner.run({}), /captcha rejected/);
  assert.equal(stopped, 1);
});

test("Python registration persists a pending account when fresh OAuth is not ready", async () => {
  let pending = 0;
  const runner = new PythonRegistrationTaskRunner({
    serviceUrl: "http://127.0.0.1:18070",
    token: null,
    timeoutMs: 60_000,
    cfMailBaseUrl: "https://mail.example.test",
    cfMailAdminPassword: "mail-admin-password",
    cfMailDomain: "mail.example.test",
    ssoConverter: {
      async registerFromSsoCookie() { throw new Error("token path should not run"); },
      async registerPendingAccount(sso, email, password) {
        assert.equal(sso, "pending-sso");
        assert.equal(email, "pending@mail.example.test");
        assert.equal(password, "private-password");
        pending += 1;
        return { accountId: "pending-account", email };
      },
    },
    mailboxStore: { saveCloudflareMailboxCredential() {} },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/internal/registration/v1/jobs")) return Response.json({ id: "pending-session" });
      if (url.includes("/sessions/pending-session?include_auth_json=1")) return Response.json({
        status: "completed",
        auth_json: { external_registration: {
          sso: "pending-sso",
          token: {},
          email: "pending@mail.example.test",
          password: "private-password",
          mailbox: { id: "mailbox-pending", address: "pending@mail.example.test", access_token: "mailbox-token" },
        } },
      });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.equal((await runner.run({})).accountId, "pending-account");
  assert.equal(pending, 1);
});

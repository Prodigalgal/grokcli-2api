import assert from "node:assert/strict";
import test from "node:test";

import type { SsoCookieCaptureRunner } from "../src/automation/browser-task-runner.js";
import { CloudflareEmailLoginTaskRunner } from "../src/registration/cloudflare-email-login-runner.js";
import { CloudflareTempMailClient } from "../src/registration/cloudflare-temp-mail.js";

test("Cloudflare email-login runner reuses a private mailbox credential without exposing it", async () => {
  const mail = new CloudflareTempMailClient({
    baseUrl: "https://mail.example.test",
    adminPassword: "private-admin-password",
    fetchImpl: async (input) => {
      assert.match(String(input), /\/api\/parsed_mails/);
      return new Response(JSON.stringify({ data: { results: [{ subject: "Sign in", text: "Use 654321 to continue" }] } }), { status: 200 });
    },
  });
  const browser: SsoCookieCaptureRunner = {
    async run() {
      return { finalUrl: "https://accounts.example.test/complete", title: "Complete" };
    },
    async runWithSsoCookie(_request, runtime) {
      assert.equal(runtime?.variables?.["account.email"], "member@example.test");
      assert.equal(await runtime?.waitForMailCode?.(), "654321");
      return { result: { finalUrl: "https://accounts.example.test/complete", title: "Complete" }, ssoCookie: "private-new-sso" };
    },
  };
  const runner = new CloudflareEmailLoginTaskRunner(browser, mail, {
    getAccount: (id) => id === "account-1" ? { id, email: "member@example.test" } : null,
    getCloudflareMailboxCredential: (id) => id === "account-1"
      ? { id: "mailbox-1", address: "member@example.test", accessToken: "private-mailbox-jwt" }
      : null,
  }, {
    async restoreFromSsoCookie(accountId, ssoCookie) {
      assert.equal(accountId, "account-1");
      assert.equal(ssoCookie, "private-new-sso");
      return { accountId, email: "member@example.test" };
    },
  });
  const result = await runner.run({
    accountId: "account-1",
    browser: {
      url: "https://accounts.example.test/sign-in",
      actions: [{ type: "fill", selector: "#email", value: "{{account.email}}" }, { type: "fill_mail_code", selector: "#code" }],
    },
  });
  assert.equal(result.accountId, "account-1");
  assert.equal(result.recoveredBy, "email_code");
  assert.equal(JSON.stringify(result).includes("private-mailbox-jwt"), false);
  assert.equal(JSON.stringify(result).includes("private-new-sso"), false);
});

test("Cloudflare email-login runner recovers an inbox at runtime", async () => {
  const mail = new CloudflareTempMailClient({
    baseUrl: "https://mail.example.test",
    adminPassword: "private-admin-password",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/admin/address?")) return new Response(JSON.stringify({ results: [{ id: "mailbox-2", address: "member@example.test" }] }));
      if (url.endsWith("/admin/show_password/mailbox-2")) return new Response(JSON.stringify({ jwt: "runtime-token" }));
      if (url.includes("/api/parsed_mails")) return new Response(JSON.stringify({ results: [{ text: "Code 112233" }] }));
      throw new Error(`unexpected URL ${url}`);
    },
  });
  const browser: SsoCookieCaptureRunner = {
    async run() { return {}; },
    async runWithSsoCookie(_request, runtime) {
      assert.equal(await runtime?.waitForMailCode?.(), "112233");
      return { result: {}, ssoCookie: "new-sso" };
    },
  };
  const runner = new CloudflareEmailLoginTaskRunner(browser, mail, {
    getAccount: () => ({ id: "account-2", email: "member@example.test" }),
    getCloudflareMailboxCredential: () => null,
  }, { async restoreFromSsoCookie(accountId) { return { accountId, email: "member@example.test" }; } });
  assert.equal((await runner.run({ accountId: "account-2", browser: { url: "https://accounts.example.test", actions: [] } })).recoveredBy, "email_code");
});

test("Cloudflare email-login runner prefers the legacy local-solver protocol", async () => {
  const mail = new CloudflareTempMailClient({ baseUrl: "https://mail.example.test", adminPassword: "secret" });
  const browser: SsoCookieCaptureRunner = { run: async () => { throw new Error("browser should not run"); }, runWithSsoCookie: async () => { throw new Error("browser should not run"); } };
  const runner = new CloudflareEmailLoginTaskRunner(browser, mail, {
    getAccount: () => ({ id: "account-3", email: "member@example.test", payload: { password: "private-password" } }),
    getCloudflareMailboxCredential: () => null,
  }, {
    async restoreFromSsoCookie(accountId, sso, token) {
      assert.equal(sso, "worker-sso");
      assert.equal(token?.access_token, "worker-access");
      return { accountId, email: "member@example.test" };
    },
  }, {
    async reauthenticate(email, password) {
      assert.equal(email, "member@example.test");
      assert.equal(password, "private-password");
      return { sso: "worker-sso", token: { access_token: "worker-access" } };
    },
  });
  assert.equal((await runner.run({ accountId: "account-3" })).recoveredBy, "legacy_local_solver_protocol");
});

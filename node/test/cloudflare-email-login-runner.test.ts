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

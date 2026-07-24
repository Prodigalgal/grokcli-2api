import assert from "node:assert/strict";
import test from "node:test";

import type { SsoCookieCaptureRunner } from "../src/automation/browser-task-runner.js";
import { CloudflareRegistrationTaskRunner } from "../src/registration/cloudflare-registration-runner.js";
import { CloudflareTempMailClient } from "../src/registration/cloudflare-temp-mail.js";

test("Cloudflare registration runner injects mailbox data and keeps the mailbox JWT private", async () => {
  const mail = new CloudflareTempMailClient({
    baseUrl: "https://mail.example.test",
    adminPassword: "private-admin-password",
    domain: "mail.example.test",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/admin/new_address")) {
        return new Response(JSON.stringify({ data: { address: "new@mail.example.test", jwt: "private-mailbox-jwt", id: "mailbox-1" } }), { status: 200 });
      }
      if (url.includes("/api/parsed_mails")) {
        return new Response(JSON.stringify({ data: { results: [{ subject: "Verification", text: "Your verification code is 123456" }] } }), { status: 200 });
      }
      throw new Error(`unexpected mail request ${url}`);
    },
  });
  const browser: SsoCookieCaptureRunner = {
    async run(request, runtime) {
      assert.equal(runtime?.proxyServer, undefined);
      assert.equal(runtime?.variables?.["mailbox.address"], "new@mail.example.test");
      assert.equal(runtime?.variables?.["mailbox.email"], "new@mail.example.test");
      assert.equal(await runtime?.waitForMailCode?.(), "123456");
      assert.ok(request.browser);
      return { finalUrl: "https://accounts.example.test/complete", title: "Complete" };
    },
    async runWithSsoCookie(request, runtime) {
      const result = await this.run(request, runtime);
      return { result, ssoCookie: "private-sso-cookie" };
    },
  };
  const storedMailbox: { accountId: string; accessToken: string }[] = [];
  const runner = new CloudflareRegistrationTaskRunner(browser, mail, {
    async registerFromSsoCookie(ssoCookie, email) {
      assert.equal(ssoCookie, "private-sso-cookie");
      assert.equal(email, "new@mail.example.test");
      return { accountId: "account-1", email };
    },
  }, {
    saveCloudflareMailboxCredential(accountId, mailbox) {
      storedMailbox.push({ accountId, accessToken: mailbox.accessToken });
    },
  });
  const result = await runner.run({
    browser: {
      url: "https://accounts.example.test/sign-up",
      actions: [
        { type: "fill", selector: "#email", value: "{{mailbox.address}}" },
        { type: "fill_mail_code", selector: "#verification-code" },
      ],
    },
  });
  assert.equal(result.email, "new@mail.example.test");
  assert.equal(result.accountId, "account-1");
  assert.equal(result.mailProvider, "cloudflare_temp_mail");
  assert.equal(JSON.stringify(result).includes("private-mailbox-jwt"), false);
  assert.equal(JSON.stringify(result).includes("private-sso-cookie"), false);
  assert.deepEqual(storedMailbox, [{ accountId: "account-1", accessToken: "private-mailbox-jwt" }]);
});

test("direct registration reports browser automation failures", async () => {
  const browser: SsoCookieCaptureRunner = {
    async run() { throw new Error("browser failed"); },
    async runWithSsoCookie() { throw new Error("browser failed"); },
  };
  const mail = new CloudflareTempMailClient({
    baseUrl: "https://mail.example.test",
    adminPassword: "private-admin-password",
    domain: "mail.example.test",
    fetchImpl: async () => new Response(JSON.stringify({ data: { address: "new@mail.example.test", jwt: "private-mailbox-jwt", id: "mailbox-1" } }), { status: 200 }),
  });
  const runner = new CloudflareRegistrationTaskRunner(browser, mail, {
    async registerFromSsoCookie() { throw new Error("should not convert"); },
  }, {
    saveCloudflareMailboxCredential() {},
  });
  await assert.rejects(() => runner.run({ browser: { url: "https://accounts.example.test", actions: [] } }), /browser failed/);
});

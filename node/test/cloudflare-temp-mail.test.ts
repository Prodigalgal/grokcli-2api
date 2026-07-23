import assert from "node:assert/strict";
import test from "node:test";

import { CloudflareTempMailClient } from "../src/registration/cloudflare-temp-mail.js";

test("Cloudflare Temp Mail creates a mailbox and extracts verification codes", async () => {
  const calls: string[] = [];
  const client = new CloudflareTempMailClient({
    baseUrl: "https://mail.example.test/",
    adminPassword: "private-admin-password",
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/open_api/settings")) {
        return new Response(JSON.stringify({ defaultDomains: ["mail.example.test"] }), { status: 200 });
      }
      if (url.endsWith("/admin/new_address")) {
        assert.equal(new Headers(init?.headers).get("x-admin-auth"), "private-admin-password");
        return new Response(JSON.stringify({ data: { address: "new@mail.example.test", jwt: "mailbox-jwt", address_id: "address-1" } }), { status: 200 });
      }
      if (url.includes("/api/parsed_mails")) {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mailbox-jwt");
        return new Response(JSON.stringify({ data: { results: [{ id: "message-1", subject: "Your code", text: "Verification code: 123456" }] } }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const mailbox = await client.createMailbox({ name: "registration-test" });
  assert.deepEqual(mailbox, { id: "address-1", address: "new@mail.example.test", accessToken: "mailbox-jwt" });
  const messages = await client.fetchMessages(mailbox);
  assert.deepEqual(messages[0]?.codes, ["123456"]);
  assert.equal(calls.some((url) => url.endsWith("/api/new_address")), false);
});

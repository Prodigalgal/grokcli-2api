import assert from "node:assert/strict";
import test from "node:test";

import { PythonReauthClient } from "../src/registration/python-reauth-client.js";

test("Python reauth client returns protocol authentication without exposing account credentials", async () => {
  const client = new PythonReauthClient({
    serviceUrl: "http://127.0.0.1:18070",
    token: "worker-token",
    timeoutMs: 30_000,
    fetchImpl: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer worker-token");
      assert.deepEqual(JSON.parse(String(init?.body)), { email: "member@example.test", password: "private-password" });
      return new Response(JSON.stringify({ ok: true, sso: "private-sso", token: { access_token: "private-access", refresh_token: "private-refresh" } }), { status: 200 });
    },
  });
  const result = await client.reauthenticate("member@example.test", "private-password");
  assert.equal(result.sso, "private-sso");
  assert.equal(result.token.access_token, "private-access");
});

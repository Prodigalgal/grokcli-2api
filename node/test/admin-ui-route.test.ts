import assert from "node:assert/strict";
import test from "node:test";

import { createApiServer } from "../src/http/health-server.js";

test("Node admin page and static assets are served without exposing an API session", async () => {
  const server = createApiServer();
  const port = await server.listen("127.0.0.1", 0);
  try {
    const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/admin");
    const page = await fetch(`http://127.0.0.1:${port}/admin`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="login-form"/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/tasks`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/keepalive`)).status, 200);
    const script = await fetch(`http://127.0.0.1:${port}/admin/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
  } finally {
    await server.close();
  }
});

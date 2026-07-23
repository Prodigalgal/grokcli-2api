import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApiServer } from "../src/http/health-server.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

test("models routes use SQLite catalog and preserve OpenAI list semantics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-models-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  store.replaceModels([{
    id: "grok-4.5",
    name: "Grok 4.5",
    description: "Primary model",
    ownedBy: "xai",
    contextWindow: 131_072,
    supportsReasoningEffort: true,
    extra: { supported_in_api: true },
    sortOrder: 10,
  }]);
  const server = createApiServer({ modelStore: store, defaultModel: "grok-4.5" });
  const port = await server.listen("127.0.0.1", 0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(response.status, 200);
    const body = await response.json() as { object: string; data: Array<Record<string, unknown>> };
    assert.equal(body.object, "list");
    assert.deepEqual(body.data.map((item) => item.id), ["grok-4.5", "grok-build", "grok-search"]);
    assert.equal(body.data[0]?.context_window, 131_072);
    assert.equal(body.data[0]?.supported_in_api, true);
  } finally {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("models routes enforce the legacy API key when configured", async () => {
  const server = createApiServer({
    apiKeyAuth: { legacyApiKey: "test-only-key", requireApiKey: "auto" },
  });
  const port = await server.listen("127.0.0.1", 0);
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/models`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${port}/models`, {
      headers: { authorization: "Bearer test-only-key" },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await server.close();
  }
});

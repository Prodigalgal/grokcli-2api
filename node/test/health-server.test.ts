import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHealthServer } from "../src/http/health-server.js";
import { ChatService } from "../src/chat/service.js";
import { createApiServer } from "../src/http/health-server.js";
import { SingleInstanceLock } from "../src/runtime/single-instance-lock.js";

test("health server listens and exposes readiness without caching", async () => {
  const server = createHealthServer();
  const port = await server.listen("127.0.0.1", 0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      ok: true,
      ready: true,
      service: "grokcli-2api-node",
      store: "sqlite",
    });
  } finally {
    await server.close();
  }
});

test("single instance lock prevents a second active API owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-lock-test-"));
  const first = SingleInstanceLock.acquire(dir);
  try {
    assert.throws(() => SingleInstanceLock.acquire(dir), /another grok2api Node instance is active/);
  } finally {
    first.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readiness rejects a Node runtime without an explicit direct xAI upstream", async () => {
  const store = {
    listPoolCandidates: () => [],
    reportPoolSuccess: () => undefined,
    reportPoolFailure: () => undefined,
  };
  const server = createApiServer({ chatService: new ChatService(store, null, "grok-4.5", "round_robin") });
  const port = await server.listen("127.0.0.1", 0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      ready: false,
      service: "grokcli-2api-node",
      store: "sqlite",
      detail: "direct xAI upstream is not configured",
    });
  } finally {
    await server.close();
  }
});

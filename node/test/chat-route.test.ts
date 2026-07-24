import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChatService } from "../src/chat/service.js";
import { createApiServer } from "../src/http/health-server.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server has no TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function writeResponsesStream(response: import("node:http").ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    'data: {"type":"response.created","response":{"id":"resp_test","model":"grok-4.5","created_at":1700000000}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_test","model":"grok-4.5","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
  ].join(""));
}

test("chat completion uses selected SQLite account and bridges responses SSE", async () => {
  const captured: { value: Record<string, unknown> | null } = { value: null };
  const upstream = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.headers.authorization, "Bearer account-token");
    assert.equal(request.headers["x-grok-conv-id"], "session-1");
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    captured.value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    writeResponsesStream(response);
  });
  const upstreamPort = await listen(upstream);
  const dir = mkdtempSync(join(tmpdir(), "grok2api-chat-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  for (let index = 0; index < 40; index++) {
    store.saveAccount({
      id: `expired-${String(index).padStart(2, "0")}`,
      payload: { access_token: `expired-token-${index}` },
      expiresAt: Date.now() - 60_000,
    });
  }
  store.saveAccount({
    id: "zz-account-1",
    payload: { access_token: "account-token", email: "user@example.test" },
  });
  const api = createApiServer({
    modelStore: store,
    apiKeyStore: store,
    defaultModel: "grok-4.5",
    chatService: new ChatService(store, `http://127.0.0.1:${upstreamPort}/v1`, "grok-4.5", "round_robin"),
  });
  const apiPort = await api.listen("127.0.0.1", 0);
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "grok-4.5", prompt_cache_key: "session-1", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { choices: Array<{ message: { content: string } }>; usage: { total_tokens: number } };
    assert.equal(body.choices[0]?.message.content, "hello");
    assert.equal(body.usage.total_tokens, 4);
    assert.equal(captured.value?.stream, true);
    assert.equal(captured.value?.prompt_cache_key, "session-1");
    assert.equal(Array.isArray(captured.value?.input), true);
    assert.equal(store.listPoolCandidates().find((candidate) => candidate.id === "zz-account-1")?.requestCount, 1);
  } finally {
    await api.close();
    await close(upstream);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streaming chat forwards bridged chunks and terminal marker", async () => {
  const upstream = createServer((_request, response) => writeResponsesStream(response));
  const upstreamPort = await listen(upstream);
  const dir = mkdtempSync(join(tmpdir(), "grok2api-chat-stream-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  store.saveAccount({ id: "account-1", payload: { access_token: "account-token" } });
  const api = createApiServer({
    chatService: new ChatService(store, `http://127.0.0.1:${upstreamPort}/v1`, "grok-4.5", "round_robin"),
  });
  const apiPort = await api.listen("127.0.0.1", 0);
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "grok-4.5", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"content":"hello"/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    await api.close();
    await close(upstream);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin account probe accepts a real xAI account id containing slashes", async () => {
  let authorization = "";
  const upstream = createServer((request, response) => { authorization = String(request.headers.authorization || ""); writeResponsesStream(response); });
  const upstreamPort = await listen(upstream);
  const dir = mkdtempSync(join(tmpdir(), "grok2api-account-probe-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  const accountId = "https://auth.x.ai::account-probe";
  store.saveAccount({ id: accountId, payload: { access_token: "probe-token" } });
  const api = createApiServer({
    adminStore: store,
    adminUsername: "admin",
    adminPassword: "secret",
    chatService: new ChatService(store, `http://127.0.0.1:${upstreamPort}/v1`, "grok-4.5", "round_robin"),
  });
  const apiPort = await api.listen("127.0.0.1", 0);
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/admin/api/accounts/probe`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-username": "admin", "x-admin-password": "secret" },
      body: JSON.stringify({ id: accountId, model: "grok-4.5" }),
    });
    assert.equal(response.status, 200);
    assert.equal(authorization, "Bearer probe-token");
    assert.equal((await response.json() as { ok: boolean }).ok, true);
  } finally {
    await api.close();
    await close(upstream);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

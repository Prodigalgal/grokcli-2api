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
        reject(new Error("missing TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("responses route maps input through chat and returns a completed response object", async () => {
  const captured: { value: Record<string, unknown> | null } = { value: null };
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    captured.value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"type":"response.created","response":{"id":"upstream","model":"grok-4.5","created_at":1700000000}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"response text"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
    ].join(""));
  });
  const upstreamPort = await listen(upstream);
  const dir = mkdtempSync(join(tmpdir(), "grok2api-responses-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  store.saveAccount({ id: "account-1", payload: { access_token: "account-token" } });
  const api = createApiServer({
    defaultModel: "grok-4.5",
    chatService: new ChatService(store, `http://127.0.0.1:${upstreamPort}/v1`, "grok-4.5", "round_robin"),
  });
  const apiPort = await api.listen("127.0.0.1", 0);
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-grok-conv-id": "grok-conversation-1" },
      body: JSON.stringify({ input: "hello", instructions: "be concise", previous_response_id: "resp_previous", metadata: { trace_id: "trace-1" } }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { object: string; status: string; output: Array<{ content: Array<{ text: string }> }>; usage: { total_tokens: number }; previous_response_id: string };
    assert.equal(body.object, "response");
    assert.equal(body.status, "completed");
    assert.equal(body.output[0]?.content[0]?.text, "response text");
    assert.equal(body.usage.total_tokens, 7);
    assert.equal(body.previous_response_id, "resp_previous");
    assert.equal(captured.value?.prompt_cache_key, "grok-conversation-1");
  } finally {
    await api.close();
    await close(upstream);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("responses streaming emits lifecycle, text, completion, and DONE events", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"type":"response.created","response":{"id":"upstream","model":"grok-4.5","created_at":1700000000}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"stream text"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2,"total_tokens":4}}}\n\n',
    ].join(""));
  });
  const upstreamPort = await listen(upstream);
  const dir = mkdtempSync(join(tmpdir(), "grok2api-responses-stream-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  store.saveAccount({ id: "account-1", payload: { access_token: "account-token" } });
  const api = createApiServer({
    defaultModel: "grok-4.5",
    chatService: new ChatService(store, `http://127.0.0.1:${upstreamPort}/v1`, "grok-4.5", "round_robin"),
  });
  const apiPort = await api.listen("127.0.0.1", 0);
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello", stream: true }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /event: response\.created/);
    assert.match(body, /event: response\.output_text\.delta/);
    assert.match(body, /"delta":"stream text"/);
    assert.match(body, /event: response\.completed/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    await api.close();
    await close(upstream);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("responses streaming preserves function-call events and argument fragments", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"type":"response.created","response":{"id":"upstream","model":"grok-4.5","created_at":1700000000}}\n\n',
      'data: {"type":"response.output_item.added","item":{"id":"fc_upstream","type":"function_call","call_id":"call_weather","name":"weather","arguments":""}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_upstream","delta":"{\\"city\\":\\"Nanjing\\"}"}\n\n',
      'data: {"type":"response.output_item.done","item":{"id":"fc_upstream","type":"function_call","call_id":"call_weather","name":"weather","arguments":"{\\"city\\":\\"Nanjing\\"}"}}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2,"total_tokens":4}}}\n\n',
    ].join(""));
  });
  const upstreamPort = await listen(upstream);
  const dir = mkdtempSync(join(tmpdir(), "grok2api-responses-tools-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  store.saveAccount({ id: "account-1", payload: { access_token: "account-token" } });
  const api = createApiServer({
    defaultModel: "grok-4.5",
    chatService: new ChatService(store, `http://127.0.0.1:${upstreamPort}/v1`, "grok-4.5", "round_robin"),
  });
  const apiPort = await api.listen("127.0.0.1", 0);
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "what is the weather", stream: true }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /event: response\.output_item\.added/);
    assert.match(body, /"type":"function_call"/);
    assert.match(body, /"call_id":"call_weather"/);
    assert.match(body, /event: response\.function_call_arguments\.delta/);
    assert.match(body, /"delta":"{\\"city\\":\\"Nanjing\\"}"/);
    assert.match(body, /event: response\.function_call_arguments\.done/);
    assert.match(body, /event: response\.output_item\.done/);
    assert.match(body, /event: response\.completed/);
  } finally {
    await api.close();
    await close(upstream);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-streaming responses returns a function-call output without a synthetic text message", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"type":"response.created","response":{"id":"upstream","model":"grok-4.5","created_at":1700000000}}\n\n',
      'data: {"type":"response.output_item.added","item":{"id":"fc_upstream","type":"function_call","call_id":"call_weather","name":"weather","arguments":""}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_upstream","delta":"{\\"city\\":\\"Nanjing\\"}"}\n\n',
      'data: {"type":"response.output_item.done","item":{"id":"fc_upstream","type":"function_call","call_id":"call_weather","name":"weather","arguments":"{\\"city\\":\\"Nanjing\\"}"}}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2,"total_tokens":4}}}\n\n',
    ].join(""));
  });
  const upstreamPort = await listen(upstream);
  const dir = mkdtempSync(join(tmpdir(), "grok2api-responses-tools-complete-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  store.saveAccount({ id: "account-1", payload: { access_token: "account-token" } });
  const api = createApiServer({
    defaultModel: "grok-4.5",
    chatService: new ChatService(store, `http://127.0.0.1:${upstreamPort}/v1`, "grok-4.5", "round_robin"),
  });
  const apiPort = await api.listen("127.0.0.1", 0);
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "what is the weather" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { output: Array<{ type: string; call_id: string; name: string; arguments: string }> };
    assert.equal(body.output.length, 1);
    assert.equal(body.output[0]?.type, "function_call");
    assert.equal(body.output[0]?.call_id, "call_weather");
    assert.equal(body.output[0]?.name, "weather");
    assert.equal(body.output[0]?.arguments, '{"city":"Nanjing"}');
  } finally {
    await api.close();
    await close(upstream);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

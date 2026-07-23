import assert from "node:assert/strict";
import test from "node:test";

import { responsesToChatBody } from "../src/protocol/openai-responses.js";
import { chatToResponsesPayload } from "../src/upstream/responses-client.js";

test("Grok Build Responses requests preserve tools, tool output, and streaming extensions", () => {
  const chat = responsesToChatBody({
    model: "grok-4.5",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    stream_tool_calls: true,
    prompt_cache_key: "conversation-1",
    tools: [
      { type: "x_search" },
      { type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ],
    input: [
      { role: "user", content: [{ type: "input_text", text: "Read package.json" }] },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"package.json\"}" },
      { type: "function_call_output", call_id: "call-1", output: "{\"name\":\"grok2api\"}" },
    ],
  }, "grok-4.5");

  const upstream = chatToResponsesPayload(chat, "grok-4.5");
  assert.equal(upstream.store, false);
  assert.deepEqual(upstream.include, ["reasoning.encrypted_content"]);
  assert.equal(upstream.stream_tool_calls, true);
  assert.equal(upstream.prompt_cache_key, "conversation-1");
  assert.deepEqual(upstream.tools, [
    { type: "x_search" },
    { type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  ]);
  assert.deepEqual(upstream.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Read package.json" }] },
    { type: "function_call", id: "call-1", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"package.json\"}" },
    { type: "function_call_output", call_id: "call-1", output: "{\"name\":\"grok2api\"}" },
  ]);
});

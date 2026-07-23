import { readSseEvents } from "./sse.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && !Array.isArray(value) && typeof value === "object" ? value as JsonObject : null;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function chatUsage(value: JsonObject): JsonObject {
  const prompt = number(value.input_tokens, number(value.prompt_tokens));
  const completion = number(value.output_tokens, number(value.completion_tokens));
  const total = number(value.total_tokens, prompt + completion);
  const inputDetails = asObject(value.input_tokens_details);
  const outputDetails = asObject(value.output_tokens_details);
  const cached = number(inputDetails?.cached_tokens, number(inputDetails?.cache_read_tokens));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_tokens: cached,
    input_tokens: prompt,
    output_tokens: completion,
    cache_read_input_tokens: cached,
    prompt_tokens_details: { cached_tokens: cached, text_tokens: number(inputDetails?.text_tokens, prompt) },
    ...(outputDetails ? { completion_tokens_details: { reasoning_tokens: number(outputDetails.reasoning_tokens, number(outputDetails.thinking_tokens)) } } : {}),
  };
}

function responseOutputText(output: unknown): string {
  if (!Array.isArray(output)) {
    return "";
  }
  return output.flatMap((raw) => {
    const item = asObject(raw);
    if (item?.type !== "message" || !Array.isArray(item.content)) {
      return [];
    }
    return item.content.map((part) => asObject(part)?.text).filter((text): text is string => typeof text === "string");
  }).join("");
}

interface BridgeState {
  id: string;
  model: string;
  created: number;
  usage: JsonObject | null;
  finish: string | null;
  emittedPayload: boolean;
  toolIndexes: Map<string, number>;
}

function chunk(state: BridgeState, delta: JsonObject, finishReason?: string): JsonObject {
  return {
    id: state.id || `chatcmpl-node-${state.created}`,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  };
}

function capture(state: BridgeState, response: JsonObject | null): void {
  if (!response) {
    return;
  }
  if (!state.id && typeof response.id === "string") {
    state.id = response.id;
  }
  if (typeof response.model === "string" && response.model) {
    state.model = response.model;
  }
  if (typeof response.created_at === "number" && response.created_at > 0) {
    state.created = response.created_at;
  }
}

export async function* responsesToChat(response: Response, fallbackModel: string): AsyncGenerator<{ readonly data: string; readonly done: boolean }> {
  const state: BridgeState = {
    id: "",
    model: fallbackModel,
    created: Math.floor(Date.now() / 1_000),
    usage: null,
    finish: null,
    emittedPayload: false,
    toolIndexes: new Map(),
  };
  let mode: "unknown" | "chat" | "responses" = "unknown";
  for await (const event of readSseEvents(response.body)) {
    if (event.data === "[DONE]") {
      if (mode === "chat") {
        yield { data: "", done: true };
      }
      continue;
    }
    let parsed: JsonObject;
    try {
      parsed = JSON.parse(event.data) as JsonObject;
    } catch {
      continue;
    }
    if (mode === "unknown") {
      mode = typeof parsed.object === "string" && parsed.object.includes("chat.completion") || Array.isArray(parsed.choices) ? "chat" : "responses";
    }
    if (mode === "chat") {
      yield { data: event.data, done: false };
      continue;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "response.created" || type === "response.in_progress") {
      capture(state, asObject(parsed.response));
      continue;
    }
    if (type === "response.output_text.delta" && typeof parsed.delta === "string" && parsed.delta) {
      state.emittedPayload = true;
      yield { data: JSON.stringify(chunk(state, { content: parsed.delta })), done: false };
      continue;
    }
    if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && typeof parsed.delta === "string" && parsed.delta) {
      state.emittedPayload = true;
      yield { data: JSON.stringify(chunk(state, { reasoning_content: parsed.delta })), done: false };
      continue;
    }
    if (type === "response.output_item.added") {
      const item = asObject(parsed.item);
      if (item?.type === "function_call") {
        const key = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : `call-${state.toolIndexes.size}`;
        const index = state.toolIndexes.get(key) ?? state.toolIndexes.size;
        state.toolIndexes.set(key, index);
        state.emittedPayload = true;
        yield {
          data: JSON.stringify(chunk(state, {
            tool_calls: [{
              index,
              id: typeof item.call_id === "string" ? item.call_id : key,
              type: "function",
              function: { name: typeof item.name === "string" ? item.name : "", arguments: typeof item.arguments === "string" ? item.arguments : "" },
            }],
          })),
          done: false,
        };
      }
      continue;
    }
    if (type === "response.function_call_arguments.delta" && typeof parsed.delta === "string" && parsed.delta) {
      const key = typeof parsed.item_id === "string" ? parsed.item_id : "";
      const index = state.toolIndexes.get(key) ?? state.toolIndexes.size;
      if (key) {
        state.toolIndexes.set(key, index);
      }
      state.emittedPayload = true;
      yield { data: JSON.stringify(chunk(state, { tool_calls: [{ index, type: "function", function: { arguments: parsed.delta } }] })), done: false };
      continue;
    }
    if (type === "response.output_item.done") {
      const item = asObject(parsed.item);
      if (item?.type === "function_call") {
        state.finish = "tool_calls";
      }
      continue;
    }
    if (type === "response.completed") {
      const completed = asObject(parsed.response);
      capture(state, completed);
      const usage = asObject(completed?.usage);
      if (usage) {
        state.usage = chatUsage(usage);
      }
      if (!state.emittedPayload) {
        const finalText = responseOutputText(completed?.output);
        if (finalText) {
          state.emittedPayload = true;
          yield { data: JSON.stringify(chunk(state, { content: finalText })), done: false };
        }
      }
    }
  }
  if (mode !== "chat") {
    if (state.usage) {
      yield { data: JSON.stringify({ ...chunk(state, {}), choices: [], usage: state.usage }), done: false };
    } else {
      yield { data: JSON.stringify(chunk(state, {}, state.finish ?? "stop")), done: false };
    }
    yield { data: "", done: true };
  }
}

export class UpstreamError extends Error {
  constructor(readonly status: number, readonly body: string, readonly retryAfter: string | null = null) {
    super(`upstream status ${status}: ${body}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      const item = asRecord(part);
      return typeof item?.text === "string" ? item.text : typeof item?.content === "string" ? item.content : "";
    }).join("");
  }
  return value === null || value === undefined ? "" : JSON.stringify(value);
}

function messageInput(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const output: unknown[] = [];
  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) {
      continue;
    }
    const role = typeof message.role === "string" ? message.role.trim().toLowerCase() : "user";
    if (role === "tool") {
      const callId = typeof message.tool_call_id === "string" ? message.tool_call_id : typeof message.call_id === "string" ? message.call_id : "call_node";
      output.push({ type: "function_call_output", call_id: callId, output: contentText(message.content) });
      continue;
    }
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        const call = asRecord(rawCall);
        const fn = asRecord(call?.function);
        const name = typeof fn?.name === "string" ? fn.name : typeof call?.name === "string" ? call.name : "";
        if (!name) {
          continue;
        }
        const argumentsValue = typeof fn?.arguments === "string" ? fn.arguments : typeof call?.arguments === "string" ? call.arguments : "{}";
        output.push({
          type: "function_call",
          id: typeof call?.id === "string" ? call.id : undefined,
          call_id: typeof call?.id === "string" ? call.id : "call_node",
          name,
          arguments: argumentsValue,
        });
      }
    }
    const text = contentText(message.content).trim();
    if (!text) {
      continue;
    }
    const normalizedRole = role === "system" ? "developer" : role === "assistant" || role === "developer" ? role : "user";
    output.push({
      type: "message",
      role: normalizedRole,
      content: [{ type: normalizedRole === "assistant" ? "output_text" : "input_text", text }],
    });
  }
  return output;
}

function responseTools(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: unknown[] = [];
  for (const raw of value) {
    const tool = asRecord(raw);
    if (!tool) {
      continue;
    }
    const fn = asRecord(tool.function);
    if (fn && typeof fn.name === "string" && fn.name.trim()) {
      output.push({
        type: "function",
        name: fn.name.trim(),
        description: typeof fn.description === "string" ? fn.description : undefined,
        parameters: fn.parameters ?? { type: "object", properties: {} },
      });
      continue;
    }
    output.push(tool);
  }
  return output;
}

function conversationId(body: Record<string, unknown>): string | null {
  for (const field of ["prompt_cache_key", "conversation_id", "conversation", "thread_id", "session_id"]) {
    if (typeof body[field] === "string" && body[field].trim()) {
      return body[field].trim();
    }
  }
  const metadata = asRecord(body.metadata);
  for (const field of ["prompt_cache_key", "session_id", "sessionId", "thread_id", "conversation_id", "user_id"]) {
    if (typeof metadata?.[field] === "string" && metadata[field].trim()) {
      return metadata[field].trim();
    }
  }
  return null;
}

export function chatToResponsesPayload(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const output: Record<string, unknown> = {
    model,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    input: Array.isArray(body.messages) ? messageInput(body.messages) : body.input ?? [],
    instructions: typeof body.instructions === "string" ? body.instructions : "",
    parallel_tool_calls: body.parallel_tool_calls ?? true,
  };
  const tools = responseTools(body.tools);
  const skipSearch = body._skip_x_search === true || body._skip_x_search === "1" || body._skip_x_search === "true";
  if (!skipSearch && !tools.some((tool) => asRecord(tool)?.type === "x_search")) {
    tools.unshift({ type: "x_search" });
  }
  if (tools.length > 0) {
    output.tools = tools;
  }
  if (typeof body.stream_tool_calls === "boolean") {
    output.stream_tool_calls = body.stream_tool_calls;
  }
  for (const field of ["temperature", "top_p", "tool_choice", "prompt_cache_key", "user", "max_output_tokens"]) {
    if (body[field] !== undefined && body[field] !== null) {
      output[field] = body[field];
    }
  }
  if (output.max_output_tokens === undefined && body.max_tokens !== undefined) {
    output.max_output_tokens = body.max_tokens;
  }
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort.trim()) {
    output.reasoning = { effort: body.reasoning_effort, summary: "auto" };
  } else if (asRecord(body.reasoning)) {
    output.reasoning = { ...asRecord(body.reasoning), summary: asRecord(body.reasoning)?.summary ?? "auto" };
  } else {
    output.reasoning = { effort: "low", summary: "auto" };
  }
  return output;
}

export interface UpstreamAccount {
  readonly id: string;
  readonly token: string;
}

export class ResponsesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async openChat(account: UpstreamAccount, model: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const payload = chatToResponsesPayload(body, model);
    const convId = conversationId(body);
    if (convId && !payload.prompt_cache_key) {
      payload.prompt_cache_key = convId;
    }
    const version = "0.2.93";
    const request: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${account.token}`,
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": version,
        "x-grok-client-identifier": "grok-shell",
        "user-agent": `xai-grok-workspace/${version}`,
        accept: "text/event-stream",
        ...(convId ? { "x-grok-conv-id": convId } : {}),
      },
      body: JSON.stringify(payload),
    };
    if (signal) {
      request.signal = signal;
    }
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, request);
    if (!response.ok) {
      const errorBody = (await response.text()).slice(0, 65_536);
      throw new UpstreamError(response.status, errorBody, response.headers.get("retry-after"));
    }
    return response;
  }
}

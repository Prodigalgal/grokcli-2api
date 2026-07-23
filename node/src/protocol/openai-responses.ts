import { randomUUID } from "node:crypto";

function object(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      const item = object(part);
      return typeof item?.text === "string" ? item.text : typeof item?.content === "string" ? item.content : "";
    }).join("");
  }
  return value === null || value === undefined ? "" : JSON.stringify(value);
}

function messages(input: unknown, instructions: unknown): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  if (typeof instructions === "string" && instructions.trim()) {
    output.push({ role: "system", content: instructions.trim() });
  }
  const entries = typeof input === "string" ? [{ type: "input_text", text: input }] : Array.isArray(input) ? input : input ? [input] : [];
  for (const raw of entries) {
    if (typeof raw === "string") {
      if (raw.trim()) {
        output.push({ role: "user", content: raw });
      }
      continue;
    }
    const item = object(raw);
    if (!item) {
      continue;
    }
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "function_call_output" || type === "tool_result") {
      output.push({
        role: "tool",
        tool_call_id: typeof item.call_id === "string" ? item.call_id : typeof item.tool_call_id === "string" ? item.tool_call_id : "call_node",
        content: text(item.output ?? item.content),
      });
      continue;
    }
    if (type === "function_call") {
      output.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "call_node",
          type: "function",
          function: {
            name: typeof item.name === "string" ? item.name : "",
            arguments: typeof item.arguments === "string" ? item.arguments : "{}",
          },
        }],
      });
      continue;
    }
    const role = typeof item.role === "string" ? item.role : type === "output_text" ? "assistant" : "user";
    const content = text(item.content ?? item.text).trim();
    if (content) {
      output.push({ role, content });
    }
  }
  return output;
}

export function responsesToChatBody(raw: Record<string, unknown>, defaultModel: string): Record<string, unknown> {
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : defaultModel;
  const body: Record<string, unknown> = {
    model,
    stream: raw.stream === true,
    messages: messages(raw.input, raw.instructions),
  };
  for (const field of ["max_output_tokens", "max_tokens", "tools", "tool_choice", "parallel_tool_calls", "stream_tool_calls", "temperature", "top_p", "user", "reasoning", "reasoning_effort", "prompt_cache_key"]) {
    if (raw[field] !== undefined && raw[field] !== null) {
      body[field === "max_output_tokens" ? "max_tokens" : field] = raw[field];
    }
  }
  const metadata = object(raw.metadata);
  if (metadata) {
    body.metadata = metadata;
    if (body.prompt_cache_key === undefined && typeof metadata.prompt_cache_key === "string") {
      body.prompt_cache_key = metadata.prompt_cache_key;
    }
  }
  return body;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function responseUsage(value: unknown): Record<string, unknown> {
  const usage = object(value) ?? {};
  const input = number(usage.prompt_tokens ?? usage.input_tokens);
  const output = number(usage.completion_tokens ?? usage.output_tokens);
  const total = number(usage.total_tokens) || input + output;
  const cached = number(usage.cached_tokens ?? object(usage.prompt_tokens_details)?.cached_tokens);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    input_tokens_details: { cached_tokens: cached },
    output_tokens_details: { reasoning_tokens: number(usage.reasoning_tokens ?? object(usage.completion_tokens_details)?.reasoning_tokens) },
    prompt_tokens: input,
    completion_tokens: output,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: number(usage.reasoning_tokens ?? object(usage.completion_tokens_details)?.reasoning_tokens) },
    cache_read_input_tokens: cached,
  };
}

export function buildResponseObject(chat: Record<string, unknown>, raw: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
  const choices = Array.isArray(chat.choices) ? chat.choices : [];
  const choice = object(choices[0]) ?? {};
  const message = object(choice.message) ?? {};
  const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
  const output: Record<string, unknown>[] = [];
  const content = typeof message.content === "string" ? message.content : "";
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (content || toolCalls.length === 0) {
    output.push({
      id: `msg_${responseId}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: content, annotations: [] }],
    });
  }
  for (const [index, rawCall] of toolCalls.entries()) {
    const call = object(rawCall) ?? {};
    const fn = object(call.function) ?? {};
    const name = typeof fn.name === "string" ? fn.name : typeof call.name === "string" ? call.name : "";
    if (!name) {
      continue;
    }
    output.push({
      id: `fc_${responseId}_${index}`,
      type: "function_call",
      status: "completed",
      call_id: typeof call.id === "string" ? call.id : `call_node_${index}`,
      name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : typeof call.arguments === "string" ? call.arguments : "{}",
    });
  }
  const result: Record<string, unknown> = {
    id: responseId,
    object: "response",
    created_at: Math.floor(now / 1_000),
    status: "completed",
    model: typeof chat.model === "string" ? chat.model : typeof raw.model === "string" ? raw.model : "grok-4.5",
    output,
    usage: responseUsage(chat.usage),
  };
  if (typeof raw.previous_response_id === "string" && raw.previous_response_id) {
    result.previous_response_id = raw.previous_response_id;
  }
  if (object(raw.metadata)) {
    result.metadata = raw.metadata;
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    result.x_grok2api_reasoning = message.reasoning_content;
  }
  return result;
}

function sseEvent(name: string, payload: Record<string, unknown>, sequence: number): string {
  return `event: ${name}\ndata: ${JSON.stringify({ ...payload, type: name, sequence_number: sequence })}\n\n`;
}

interface ResponseFunctionCall {
  readonly index: number;
  readonly id: string;
  readonly callId: string;
  name: string;
  arguments: string;
  readonly outputIndex: number;
}

export class ResponsesLiveEncoder {
  private sequence = 0;
  private textOpen = false;
  private reasoningOpen = false;
  private reasoningOutputIndex: number | null = null;
  private textOutputIndex: number | null = null;
  private nextOutputIndex = 0;
  private text = "";
  private reasoning = "";
  private usage: Record<string, unknown> | null = null;
  private readonly toolCalls = new Map<number, ResponseFunctionCall>();
  private model: string;

  constructor(
    private readonly responseId: string,
    model: string,
    private readonly raw: Record<string, unknown>,
    private readonly createdAt = Math.floor(Date.now() / 1_000),
  ) {
    this.model = model;
  }

  start(): string[] {
    const initial = this.initial();
    return [
      this.event("response.created", { response: initial }),
      this.event("response.in_progress", { response: initial }),
    ];
  }

  feed(rawChunk: string): string[] {
    const chunk = JSON.parse(rawChunk) as Record<string, unknown>;
    if (typeof chunk.model === "string" && chunk.model) {
      this.model = chunk.model;
    }
    if (chunk.usage && typeof chunk.usage === "object" && !Array.isArray(chunk.usage)) {
      this.usage = chunk.usage as Record<string, unknown>;
    }
    if (!Array.isArray(chunk.choices)) {
      return [];
    }
    const frames: string[] = [];
    for (const rawChoice of chunk.choices) {
      const choice = object(rawChoice);
      const delta = object(choice?.delta);
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
        if (!this.reasoningOpen) {
          this.reasoningOpen = true;
          this.reasoningOutputIndex = this.nextOutputIndex++;
          frames.push(this.event("response.output_item.added", {
            output_index: this.reasoningOutputIndex,
            item: { id: `rs_${this.responseId}`, type: "reasoning", status: "in_progress", summary: [] },
          }));
          frames.push(this.event("response.reasoning_summary_part.added", {
            item_id: `rs_${this.responseId}`, output_index: this.reasoningOutputIndex, summary_index: 0,
            part: { type: "summary_text", text: "" },
          }));
        }
        this.reasoning += delta.reasoning_content;
        frames.push(this.event("response.reasoning_summary_text.delta", {
          item_id: `rs_${this.responseId}`, output_index: this.reasoningOutputIndex ?? 0, summary_index: 0, delta: delta.reasoning_content,
        }));
      }
      if (typeof delta?.content === "string" && delta.content) {
        if (!this.textOpen) {
          this.textOpen = true;
          this.textOutputIndex = this.nextOutputIndex++;
          frames.push(this.event("response.output_item.added", {
            output_index: this.textOutputIndex,
            item: { id: `msg_${this.responseId}`, type: "message", role: "assistant", status: "in_progress", content: [] },
          }));
          frames.push(this.event("response.content_part.added", {
            item_id: `msg_${this.responseId}`, output_index: this.textOutputIndex, content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }));
        }
        this.text += delta.content;
        frames.push(this.event("response.output_text.delta", {
          item_id: `msg_${this.responseId}`, output_index: this.textOutputIndex ?? 0, content_index: 0, delta: delta.content,
        }));
      }
      if (Array.isArray(delta?.tool_calls)) {
        frames.push(...this.feedToolCalls(delta.tool_calls));
      }
    }
    return frames;
  }

  complete(): string[] {
    const frames: string[] = [];
    if (this.reasoningOpen) {
      frames.push(this.event("response.reasoning_summary_part.done", { item_id: `rs_${this.responseId}`, output_index: this.reasoningOutputIndex ?? 0, summary_index: 0, part: { type: "summary_text", text: this.reasoning } }));
      frames.push(this.event("response.output_item.done", { output_index: this.reasoningOutputIndex ?? 0, item: { id: `rs_${this.responseId}`, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: this.reasoning }] } }));
    }
    if (this.textOpen) {
      frames.push(this.event("response.output_text.done", { item_id: `msg_${this.responseId}`, output_index: this.textOutputIndex ?? 0, content_index: 0, text: this.text }));
      frames.push(this.event("response.content_part.done", { item_id: `msg_${this.responseId}`, output_index: this.textOutputIndex ?? 0, content_index: 0, part: { type: "output_text", text: this.text, annotations: [] } }));
      frames.push(this.event("response.output_item.done", { output_index: this.textOutputIndex ?? 0, item: { id: `msg_${this.responseId}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: this.text, annotations: [] }] } }));
    }
    for (const call of this.sortedToolCalls()) {
      frames.push(this.event("response.function_call_arguments.done", {
        item_id: call.id, output_index: call.outputIndex, arguments: call.arguments,
      }));
      frames.push(this.event("response.output_item.done", {
        output_index: call.outputIndex, item: this.functionItem(call, "completed"),
      }));
    }
    frames.push(this.event("response.completed", { response: this.completedObject() }));
    frames.push("data: [DONE]\n\n");
    return frames;
  }

  fail(message: string): string[] {
    return [
      this.event("response.failed", {
        response: { id: this.responseId, object: "response", status: "failed", model: this.model, error: { type: "server_error", message } },
      }),
      "data: [DONE]\n\n",
    ];
  }

  private initial(): Record<string, unknown> {
    return { id: this.responseId, object: "response", created_at: this.createdAt, status: "in_progress", model: this.model, output: [], usage: responseUsage({}) };
  }

  private completedObject(): Record<string, unknown> {
    const output: Array<{ readonly index: number; readonly item: Record<string, unknown> }> = [];
    if (this.reasoningOpen) {
      output.push({ index: this.reasoningOutputIndex ?? 0, item: { id: `rs_${this.responseId}`, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: this.reasoning }] } });
    }
    if (this.textOpen || this.toolCalls.size === 0) {
      output.push({ index: this.textOutputIndex ?? this.nextOutputIndex, item: { id: `msg_${this.responseId}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: this.text, annotations: [] }] } });
    }
    for (const call of this.sortedToolCalls()) {
      output.push({ index: call.outputIndex, item: this.functionItem(call, "completed") });
    }
    const result: Record<string, unknown> = {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status: "completed",
      model: this.model,
      output: output.sort((left, right) => left.index - right.index).map((entry) => entry.item),
      usage: responseUsage(this.usage),
    };
    if (typeof this.raw.previous_response_id === "string" && this.raw.previous_response_id) {
      result.previous_response_id = this.raw.previous_response_id;
    }
    if (object(this.raw.metadata)) {
      result.metadata = this.raw.metadata;
    }
    return result;
  }

  private event(name: string, payload: Record<string, unknown>): string {
    const output = sseEvent(name, payload, this.sequence);
    this.sequence += 1;
    return output;
  }

  private feedToolCalls(rawCalls: unknown[]): string[] {
    const frames: string[] = [];
    for (const rawCall of rawCalls) {
      const incoming = object(rawCall);
      if (!incoming) {
        continue;
      }
      const index = typeof incoming.index === "number" && Number.isInteger(incoming.index) && incoming.index >= 0 ? incoming.index : 0;
      const functionData = object(incoming.function) ?? {};
      let call = this.toolCalls.get(index);
      if (!call) {
        const callId = typeof incoming.id === "string" && incoming.id ? incoming.id : `call_node_${index}`;
        call = {
          index,
          id: `fc_${this.responseId}_${index}`,
          callId,
          name: typeof functionData.name === "string" ? functionData.name : "",
          arguments: "",
          outputIndex: this.nextOutputIndex++,
        };
        this.toolCalls.set(index, call);
        frames.push(this.event("response.output_item.added", {
          output_index: call.outputIndex, item: this.functionItem(call, "in_progress"),
        }));
      }
      if (typeof functionData.name === "string" && functionData.name) {
        call.name = functionData.name;
      }
      if (typeof functionData.arguments === "string" && functionData.arguments) {
        call.arguments += functionData.arguments;
        frames.push(this.event("response.function_call_arguments.delta", {
          item_id: call.id, output_index: call.outputIndex, delta: functionData.arguments,
        }));
      }
    }
    return frames;
  }

  private functionItem(call: ResponseFunctionCall, status: "in_progress" | "completed"): Record<string, unknown> {
    return {
      id: call.id,
      type: "function_call",
      status,
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
    };
  }

  private sortedToolCalls(): ResponseFunctionCall[] {
    return [...this.toolCalls.values()].sort((left, right) => left.outputIndex - right.outputIndex);
  }
}

import { randomUUID } from "node:crypto";

import { candidateChain, type PoolCandidate, type PoolMode } from "../pool/picker.js";
import { responsesToChat } from "../protocol/responses-to-chat.js";
import type { UsageEventInput } from "../storage/sqlite-store.js";
import { ResponsesClient, UpstreamError } from "../upstream/responses-client.js";

export interface ChatPoolStore {
  listPoolCandidates(): PoolCandidate[];
  reportPoolSuccess(accountId: string, now?: number): void;
  reportPoolFailure(accountId: string, error: string, now?: number): void;
}

export interface ChatCompletion {
  readonly payload: Record<string, unknown>;
  readonly accountId: string;
}

export interface ChatExecutionContext {
  readonly requestId?: string;
  readonly apiKeyId?: string | null;
  readonly protocol?: "chat_completions" | "responses";
}

export interface UsageSink {
  record(event: UsageEventInput): void;
}

interface Collector {
  id: string;
  model: string;
  created: number;
  content: string;
  reasoning: string;
  usage: Record<string, unknown> | null;
  finishReason: string;
  toolCalls: Map<number, Record<string, unknown>>;
}

function collectFrame(collector: Collector, raw: string): void {
  const event = JSON.parse(raw) as Record<string, unknown>;
  if (typeof event.id === "string") {
    collector.id = event.id;
  }
  if (typeof event.model === "string") {
    collector.model = event.model;
  }
  if (typeof event.created === "number") {
    collector.created = event.created;
  }
  if (event.usage && typeof event.usage === "object" && !Array.isArray(event.usage)) {
    collector.usage = event.usage as Record<string, unknown>;
  }
  if (!Array.isArray(event.choices)) {
    return;
  }
  for (const rawChoice of event.choices) {
    const choice = rawChoice as Record<string, unknown>;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === "string") {
      collector.content += delta.content;
    }
    if (typeof delta?.reasoning_content === "string") {
      collector.reasoning += delta.reasoning_content;
    }
    if (typeof choice.finish_reason === "string") {
      collector.finishReason = choice.finish_reason;
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        const call = rawCall as Record<string, unknown>;
        const index = typeof call.index === "number" ? call.index : 0;
        const existing = collector.toolCalls.get(index) ?? { index, type: "function", function: {} };
        if (typeof call.id === "string") {
          existing.id = call.id;
        }
        const existingFunction = existing.function as Record<string, unknown>;
        const incomingFunction = call.function as Record<string, unknown> | undefined;
        if (typeof incomingFunction?.name === "string" && incomingFunction.name) {
          existingFunction.name = incomingFunction.name;
        }
        if (typeof incomingFunction?.arguments === "string") {
          existingFunction.arguments = `${typeof existingFunction.arguments === "string" ? existingFunction.arguments : ""}${incomingFunction.arguments}`;
        }
        existing.function = existingFunction;
        collector.toolCalls.set(index, existing);
      }
    }
  }
}

function collectorResult(collector: Collector): Record<string, unknown> {
  const toolCalls = [...collector.toolCalls.values()].sort((left, right) => Number(left.index) - Number(right.index));
  const message: Record<string, unknown> = { role: "assistant", content: collector.content || (toolCalls.length > 0 ? null : "") };
  if (collector.reasoning) {
    message.reasoning_content = collector.reasoning;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return {
    id: collector.id || `chatcmpl-node-${collector.created}`,
    object: "chat.completion",
    created: collector.created,
    model: collector.model,
    choices: [{ index: 0, message, finish_reason: collector.finishReason || (toolCalls.length > 0 ? "tool_calls" : "stop") }],
    usage: collector.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function usageTotals(value: unknown): { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number; readonly cacheReadTokens: number } {
  const usage = value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
  const number = (raw: unknown): number => typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
  const prompt = number(usage.prompt_tokens ?? usage.input_tokens);
  const completion = number(usage.completion_tokens ?? usage.output_tokens);
  const details = usage.prompt_tokens_details && !Array.isArray(usage.prompt_tokens_details) && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : {};
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: Math.max(number(usage.total_tokens), prompt + completion),
    cacheReadTokens: Math.min(prompt, number(usage.cached_tokens ?? usage.cache_read_input_tokens ?? details.cached_tokens)),
  };
}

function usageFromFrame(raw: string): Record<string, unknown> | null {
  try {
    const event = JSON.parse(raw) as Record<string, unknown>;
    return event.usage && !Array.isArray(event.usage) && typeof event.usage === "object" ? event.usage as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function shouldTryAnotherAccount(error: unknown): boolean {
  if (!(error instanceof UpstreamError)) {
    return true;
  }
  if (error.status >= 500) {
    return true;
  }
  return [401, 403, 408, 409, 425, 429].includes(error.status);
}

export class ChatService {
  private readonly upstream: ResponsesClient | null;

  constructor(
    private readonly store: ChatPoolStore,
    upstreamBase: string | null,
    private defaultModel: string,
    private poolMode: PoolMode,
    private readonly usage?: UsageSink | null,
  ) {
    this.upstream = upstreamBase ? new ResponsesClient(upstreamBase) : null;
  }

  isUpstreamConfigured(): boolean {
    return this.upstream !== null;
  }

  updateRuntime(settings: { readonly defaultModel?: string; readonly poolMode?: PoolMode }): void {
    if (settings.defaultModel?.trim()) this.defaultModel = settings.defaultModel.trim();
    if (settings.poolMode) this.poolMode = settings.poolMode;
  }

  async probeAccount(accountId: string, model = this.defaultModel, signal?: AbortSignal): Promise<{ readonly ok: true; readonly accountId: string; readonly model: string }> {
    const candidate = this.store.listPoolCandidates().find((item) => item.id === accountId);
    if (!candidate) throw new Error("account is not eligible for probing");
    if (!this.upstream) throw new UpstreamError(503, "direct xAI upstream is not configured");
    try {
      const response = await this.upstream.openChat(candidate, model, { messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, _skip_x_search: true }, signal);
      const reader = response.body?.getReader();
      if (reader) {
        await reader.read();
        await reader.cancel();
      }
      this.store.reportPoolSuccess(accountId);
      return { ok: true, accountId, model };
    } catch (error) {
      this.store.reportPoolFailure(accountId, error instanceof Error ? error.message : "probe failed");
      throw error;
    }
  }

  async complete(body: Record<string, unknown>, context: ChatExecutionContext = {}, signal?: AbortSignal): Promise<ChatCompletion> {
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : this.defaultModel;
    const chain = candidateChain(this.store.listPoolCandidates(), model, this.poolMode, 6);
    if (chain.length === 0) {
      this.recordUsage(context, context.requestId ?? randomUUID(), null, model, false, {});
      throw new Error("no eligible accounts");
    }
    if (!this.upstream) {
      throw new UpstreamError(503, "direct xAI upstream is not configured");
    }
    let lastError: unknown;
    for (const candidate of chain) {
      try {
        const response = await this.upstream.openChat(candidate, model, body, signal);
        const collector: Collector = { id: "", model, created: Math.floor(Date.now() / 1_000), content: "", reasoning: "", usage: null, finishReason: "", toolCalls: new Map() };
        for await (const frame of responsesToChat(response, model)) {
          if (!frame.done) {
            collectFrame(collector, frame.data);
          }
        }
        this.store.reportPoolSuccess(candidate.id);
        const payload = collectorResult(collector);
        this.recordUsage(context, context.requestId ?? randomUUID(), candidate.id, model, true, payload.usage);
        return { payload, accountId: candidate.id };
      } catch (error) {
        lastError = error;
        if (!shouldTryAnotherAccount(error)) {
          this.recordUsage(context, context.requestId ?? randomUUID(), candidate.id, model, false, {});
          throw error;
        }
        this.store.reportPoolFailure(candidate.id, error instanceof Error ? error.message : "upstream failure");
      }
    }
    this.recordUsage(context, context.requestId ?? randomUUID(), chain.at(-1)?.id ?? null, model, false, {});
    throw lastError instanceof Error ? lastError : new UpstreamError(502, "all upstream accounts failed");
  }

  async *stream(body: Record<string, unknown>, context: ChatExecutionContext = {}, signal?: AbortSignal): AsyncGenerator<{ readonly data: string; readonly done: boolean }> {
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : this.defaultModel;
    const chain = candidateChain(this.store.listPoolCandidates(), model, this.poolMode, 6);
    if (chain.length === 0) {
      this.recordUsage(context, context.requestId ?? randomUUID(), null, model, false, {});
      throw new Error("no eligible accounts");
    }
    if (!this.upstream) {
      throw new UpstreamError(503, "direct xAI upstream is not configured");
    }
    let lastError: unknown;
    for (const candidate of chain) {
      try {
        const response = await this.upstream.openChat(candidate, model, body, signal);
        let usage: Record<string, unknown> = {};
        for await (const frame of responsesToChat(response, model)) {
          if (!frame.done) {
            usage = usageFromFrame(frame.data) ?? usage;
          }
          yield frame;
        }
        this.store.reportPoolSuccess(candidate.id);
        this.recordUsage(context, context.requestId ?? randomUUID(), candidate.id, model, true, usage);
        return;
      } catch (error) {
        lastError = error;
        if (!shouldTryAnotherAccount(error)) {
          this.recordUsage(context, context.requestId ?? randomUUID(), candidate.id, model, false, {});
          throw error;
        }
        this.store.reportPoolFailure(candidate.id, error instanceof Error ? error.message : "upstream failure");
      }
    }
    this.recordUsage(context, context.requestId ?? randomUUID(), chain.at(-1)?.id ?? null, model, false, {});
    throw lastError instanceof Error ? lastError : new UpstreamError(502, "all upstream accounts failed");
  }

  private recordUsage(
    context: ChatExecutionContext,
    requestId: string,
    accountId: string | null,
    model: string,
    success: boolean,
    rawUsage: unknown,
  ): void {
    if (!this.usage) {
      return;
    }
    const totals = usageTotals(rawUsage);
    this.usage.record({
      requestId,
      apiKeyId: context.apiKeyId ?? null,
      accountId,
      model,
      protocol: context.protocol ?? "chat_completions",
      success,
      ...totals,
    });
  }
}

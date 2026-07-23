import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { issueApiKey } from "../auth/api-key-manager.js";
import { requireApiKey, type ApiKeyAuthConfig, type ApiKeyStore } from "../auth/api-key-auth.js";
import type { ChatService } from "../chat/service.js";
import type { DeviceLoginService } from "../auth/device-login-service.js";
import type { AutomationTaskRepository, AutomationTask } from "../automation/task-repository.js";
import type { AutomationTaskWorker } from "../automation/task-worker.js";
import { openAiModelList, type ModelStore } from "../models/catalog.js";
import { buildResponseObject, ResponsesLiveEncoder, responsesToChatBody } from "../protocol/openai-responses.js";
import { UpstreamError } from "../upstream/responses-client.js";
import type { SqliteStore } from "../storage/sqlite-store.js";

export interface HealthServer {
  listen(host: string, port: number): Promise<number>;
  close(): Promise<void>;
}

export interface ApiServerOptions {
  readonly modelStore?: ModelStore | null;
  readonly apiKeyStore?: ApiKeyStore | null;
  readonly defaultModel?: string;
  readonly apiKeyAuth?: ApiKeyAuthConfig;
  readonly chatService?: ChatService | null;
  readonly deviceLogins?: DeviceLoginService | null;
  readonly automationTasks?: AutomationTaskRepository | null;
  readonly automationWorker?: Pick<AutomationTaskWorker, "cancel"> | null;
  readonly registrationAvailable?: boolean;
  readonly registrationDefaults?: {
    readonly mailBaseUrl: string | null;
    readonly mailDomain: string | null;
    readonly proxyConfigured: boolean;
  };
  readonly adminStore?: SqliteStore | null;
  readonly adminUsername?: string | null;
  readonly adminPassword?: string | null;
}

function statusFor(error: unknown): number {
  return error instanceof UpstreamError ? Math.max(502, error.status) : 502;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "upstream request failed";
}

function requestBody(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (!body || Array.isArray(body) || typeof body !== "object") {
    throw new Error("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function withGrokConversationHint(request: FastifyRequest, body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) {
    return body;
  }
  for (const name of ["x-grok-conv-id", "x-grok-session-id"] as const) {
    const raw = request.headers[name];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value) {
      return { ...body, prompt_cache_key: value };
    }
  }
  return body;
}

function beginSse(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function writeSse(reply: FastifyReply, data: string): void {
  reply.raw.write(data);
}

function sameSecret(candidate: string, expected: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function hasAdminAccess(request: FastifyRequest, username: string | null, password: string | null): boolean {
  if (!password) {
    return false;
  }
  const raw = request.headers["x-admin-password"];
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  const candidate = typeof supplied === "string" ? supplied : "";
  const rawUsername = request.headers["x-admin-username"];
  const suppliedUsername = Array.isArray(rawUsername) ? rawUsername[0] : rawUsername;
  return sameSecret(candidate, password)
    && (!username || sameSecret(typeof suppliedUsername === "string" ? suppliedUsername : "", username));
}

function publicTask(task: AutomationTask): Record<string, unknown> {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    attempts: task.attempts,
    result: task.result,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
  };
}

function adminAsset(name: "index.html" | "app.css" | "app.js"): string {
  return readFileSync(resolve(process.cwd(), "public", "admin", name), "utf8");
}

export function createApiServer(options: ApiServerOptions = {}): HealthServer {
  const modelStore = options.modelStore ?? null;
  const apiKeyStore = options.apiKeyStore ?? null;
  const defaultModel = options.defaultModel?.trim() || "grok-4.5";
  const apiKeyAuth: ApiKeyAuthConfig = options.apiKeyAuth ?? { legacyApiKey: null, requireApiKey: "auto" };
  const chatService = options.chatService ?? null;
  const deviceLogins = options.deviceLogins ?? null;
  const automationTasks = options.automationTasks ?? null;
  const automationWorker = options.automationWorker ?? null;
  const registrationAvailable = options.registrationAvailable ?? true;
  const adminStore = options.adminStore ?? null;
  const adminUsername = options.adminUsername?.trim() || null;
  const adminPassword = options.adminPassword?.trim() || null;
  const app = Fastify({
    bodyLimit: 8 * 1024 * 1024,
    logger: false,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (reply.sent) {
      return;
    }
    reply.code(500).header("cache-control", "no-store").send({ detail: messageFor(error) });
  });

  app.get("/live", async (_request, reply) => reply.header("cache-control", "no-store").send({ ok: true, service: "grok2api" }));
  const readiness = async (_request: FastifyRequest, reply: FastifyReply) => {
    const upstreamConfigured = chatService === null || chatService.isUpstreamConfigured();
    return reply.code(upstreamConfigured ? 200 : 503).header("cache-control", "no-store").send({
      ok: upstreamConfigured,
      ready: upstreamConfigured,
      service: "grok2api",
      store: "sqlite",
      ...(upstreamConfigured ? {} : { detail: "direct xAI upstream is not configured" }),
    });
  };
  app.get("/ready", readiness);
  app.get("/health", readiness);

  app.get("/", async (_request, reply) => reply.redirect("/admin"));
  for (const path of ["/admin", "/admin/"]) {
    app.get(path, async (_request, reply) => reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(adminAsset("index.html")));
  }
  app.get("/admin/app.css", async (_request, reply) => reply.type("text/css; charset=utf-8").header("cache-control", "public, max-age=300").send(adminAsset("app.css")));
  app.get("/admin/app.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").header("cache-control", "public, max-age=300").send(adminAsset("app.js")));

  const requireAdmin = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!adminPassword) {
      reply.code(503).header("cache-control", "no-store").send({ detail: "admin API is disabled" });
      return false;
    }
    if (!hasAdminAccess(request, adminUsername, adminPassword)) {
      reply.code(401).header("cache-control", "no-store").send({ detail: "invalid admin credentials" });
      return false;
    }
    return true;
  };

  const requireAdminStore = (request: FastifyRequest, reply: FastifyReply): SqliteStore | null => {
    if (!requireAdmin(request, reply)) {
      return null;
    }
    if (!adminStore) {
      reply.code(503).header("cache-control", "no-store").send({ detail: "SQLite admin store is unavailable" });
      return null;
    }
    return adminStore;
  };

  app.get("/admin/api/status", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const keys = store.listApiKeySummaries();
    const pool = store.poolSummary();
    return reply.header("cache-control", "no-store").send({
      ok: true,
      store: { backend: "sqlite", redis: false, postgresql: false },
      accounts: { account_count: store.countAccounts(), active_count: pool.live },
      pool,
      models_count: store.countModels(),
      keys: {
        total: keys.length,
        enabled: keys.filter((key) => key.enabled).length,
        disabled: keys.filter((key) => !key.enabled).length,
        total_requests: keys.reduce((total, key) => total + key.requestCount, 0),
      },
      direct_xai: { configured: chatService?.isUpstreamConfigured() ?? false },
      registration: { provider: "cloudflare_temp_mail", available: registrationAvailable },
      usage: store.usageSummary(),
    });
  });

  app.get("/admin/api/models", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    return reply.header("cache-control", "no-store").send({
      ...openAiModelList(store, defaultModel),
      default_model: defaultModel,
      storage: "sqlite",
    });
  });

  app.get("/admin/api/usage/summary", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    return reply.header("cache-control", "no-store").send({ ok: true, ...store.usageSummary(), storage: "sqlite" });
  });

  app.get("/admin/api/accounts", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const query = request.query as { q?: unknown; status?: unknown; sort?: unknown; page?: unknown; page_size?: unknown };
    const status = typeof query.status === "string" && query.status.trim() ? query.status.trim() : undefined;
    if (status !== undefined && !["active", "disabled", "quota_disabled", "cooldown", "expired"].includes(status)) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "unsupported account status filter" });
    }
    const sort = typeof query.sort === "string" && query.sort.trim() ? query.sort.trim() : undefined;
    if (sort !== undefined && !["id", "email", "expires_at", "last_used_at", "request_count"].includes(sort)) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "unsupported account sort" });
    }
    const numberQuery = (value: unknown): number | undefined => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
    const page = numberQuery(query.page);
    const pageSize = numberQuery(query.page_size);
    const result = store.listAccountSummaries({
      ...(typeof query.q === "string" && query.q.trim() ? { query: query.q } : {}),
      ...(status ? { status: status as "active" | "disabled" | "quota_disabled" | "cooldown" | "expired" } : {}),
      ...(sort ? { sort: sort as "id" | "email" | "expires_at" | "last_used_at" | "request_count" } : {}),
      ...(page ? { page } : {}),
      ...(pageSize ? { pageSize } : {}),
    });
    return reply.header("cache-control", "no-store").send({ ...result, pool: store.poolSummary(), store_source: "sqlite" });
  });

  app.patch("/admin/api/accounts/:id/enabled", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const enabled = requestBody(request).enabled;
    if (typeof enabled !== "boolean") {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "enabled must be a boolean" });
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    if (!store.getAccountSummary(id)) {
      return reply.code(404).header("cache-control", "no-store").send({ detail: "account was not found" });
    }
    store.updatePoolEligibility(id, { enabled });
    return reply.header("cache-control", "no-store").send({ ok: true, account: store.getAccountSummary(id) });
  });

  app.post("/admin/api/accounts/:id/cooldown/clear", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    if (!store.getAccountSummary(id)) {
      return reply.code(404).header("cache-control", "no-store").send({ detail: "account was not found" });
    }
    store.updatePoolEligibility(id, { cooldownUntil: null });
    return reply.header("cache-control", "no-store").send({ ok: true, account: store.getAccountSummary(id) });
  });

  app.delete("/admin/api/accounts/:id", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    return store.deleteAccount(id)
      ? reply.header("cache-control", "no-store").send({ ok: true, account_id: id })
      : reply.code(404).header("cache-control", "no-store").send({ detail: "account was not found" });
  });

  app.get("/admin/api/keys", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const keys = store.listApiKeySummaries();
    return reply.header("cache-control", "no-store").send({
      keys,
      stats: { total: keys.length, enabled: keys.filter((key) => key.enabled).length, disabled: keys.filter((key) => !key.enabled).length },
      store_source: "sqlite",
    });
  });

  app.post("/admin/api/keys", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const body = requestBody(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!name || name.length > 120 || note.length > 1_000) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "name is required and note is limited to 1000 characters" });
    }
    const issued = issueApiKey();
    const key = store.createApiKey({ id: issued.id, name, note, prefix: issued.prefix, keyHash: issued.keyHash, secret: issued.secret });
    return reply.code(201).header("cache-control", "no-store").send({ ok: true, key, secret: issued.secret });
  });

  app.patch("/admin/api/keys/:id", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const body = requestBody(request);
    const name = body.name === undefined ? undefined : typeof body.name === "string" ? body.name : null;
    const note = body.note === undefined ? undefined : typeof body.note === "string" ? body.note : null;
    const enabled = body.enabled === undefined ? undefined : typeof body.enabled === "boolean" ? body.enabled : null;
    if (name === null || note === null || enabled === null || (name === undefined && note === undefined && enabled === undefined)) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "name, note, or enabled must be supplied with valid types" });
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    try {
      const key = store.updateApiKey(id, { ...(name === undefined ? {} : { name }), ...(note === undefined ? {} : { note }), ...(enabled === undefined ? {} : { enabled }) });
      return reply.header("cache-control", "no-store").send({ ok: true, key });
    } catch (error) {
      return reply.code(messageFor(error).includes("not found") ? 404 : 400).header("cache-control", "no-store").send({ detail: messageFor(error) });
    }
  });

  app.post("/admin/api/keys/:id/regenerate", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    const issued = issueApiKey();
    try {
      const key = store.rotateApiKey(id, issued.prefix, issued.keyHash, issued.secret);
      return reply.header("cache-control", "no-store").send({ ok: true, key, secret: issued.secret });
    } catch (error) {
      return reply.code(404).header("cache-control", "no-store").send({ detail: messageFor(error) });
    }
  });

  app.delete("/admin/api/keys/:id", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    return store.deleteApiKey(id)
      ? reply.header("cache-control", "no-store").send({ ok: true, key_id: id })
      : reply.code(404).header("cache-control", "no-store").send({ detail: "API key was not found" });
  });

  app.post("/admin/api/device/login", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    if (!deviceLogins) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "device login is unavailable" });
    }
    const body = requestBody(request);
    const accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
    const session = await deviceLogins.start(accountId || undefined);
    return reply.header("cache-control", "no-store").send({ ok: true, session });
  });

  app.get("/admin/api/device/sessions", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    if (!deviceLogins) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "device login is unavailable" });
    }
    const sessions = deviceLogins.list();
    return reply.header("cache-control", "no-store").send({ ok: true, sessions, count: sessions.length });
  });

  app.get("/admin/api/device/sessions/:id", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    if (!deviceLogins) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "device login is unavailable" });
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    const session = deviceLogins.get(id);
    return session
      ? reply.header("cache-control", "no-store").send({ ok: true, session })
      : reply.code(404).header("cache-control", "no-store").send({ detail: "device login session was not found" });
  });

  app.post("/admin/api/device/sessions/:id/restart", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    if (!deviceLogins) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "device login is unavailable" });
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    const previous = deviceLogins.get(id);
    if (!previous) {
      return reply.code(404).header("cache-control", "no-store").send({ detail: "device login session was not found" });
    }
    const session = await deviceLogins.start(previous.targetAccountId ?? undefined);
    return reply.header("cache-control", "no-store").send({ ok: true, session });
  });

  const enqueueBrowserTask = async (request: FastifyRequest, reply: FastifyReply, kind: "browser_automation" | "registration") => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    if (!automationTasks) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "automation tasks are unavailable" });
    }
    if (kind === "registration" && !registrationAvailable) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "registration mail or dedicated proxy is not configured" });
    }
    const body = requestBody(request);
    const browser = body.browser;
    if (!browser || Array.isArray(browser) || typeof browser !== "object") {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "browser task configuration is required" });
    }
    const idempotencyKey = typeof body.idempotency_key === "string" && body.idempotency_key.trim()
      ? body.idempotency_key.trim()
      : `${kind}:${randomUUID()}`;
    const mailbox = body.mailbox;
    if (mailbox !== undefined && (Array.isArray(mailbox) || !mailbox || typeof mailbox !== "object")) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "mailbox must be an object" });
    }
    const task = automationTasks.enqueue(kind, idempotencyKey, {
      browser,
      ...(kind === "registration" && mailbox ? { mailbox: mailbox as Record<string, unknown> } : {}),
    });
    return reply.code(202).header("cache-control", "no-store").send({ ok: true, task: publicTask(task) });
  };

  app.post("/admin/api/automation/browser", async (request, reply) => enqueueBrowserTask(request, reply, "browser_automation"));
  app.post("/admin/api/accounts/register", async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    if (!automationTasks || !registrationAvailable) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "registration worker is unavailable" });
    }
    const body = requestBody(request);
    const count = typeof body.count === "number" && Number.isInteger(body.count) ? body.count : 1;
    if (count < 1 || count > 20) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "registration count must be between 1 and 20" });
    }
    const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
    const registration = {
      proxySubscriptionUrl: text(body.proxy_subscription_url),
      mailBaseUrl: text(body.mail_base_url),
      mailApiKey: text(body.mail_api_key),
      mailDomain: text(body.mail_domain),
    };
    for (const [name, value] of [["proxy subscription", registration.proxySubscriptionUrl], ["mail base URL", registration.mailBaseUrl]] as const) {
      if (value && !value.startsWith("https://")) {
        return reply.code(400).header("cache-control", "no-store").send({ detail: `${name} must use https` });
      }
    }
    const baseKey = text(body.idempotency_key) || `registration:${randomUUID()}`;
    const tasks = Array.from({ length: count }, (_unused, index) => automationTasks.enqueue("registration", `${baseKey}:${index + 1}`, {
      browser: {},
      registration,
      mailbox: registration.mailDomain ? { domain: registration.mailDomain } : {},
    }));
    return reply.code(202).header("cache-control", "no-store").send({ ok: true, tasks: tasks.map(publicTask), count: tasks.length });
  });
  app.post("/admin/api/accounts/:id/email-login", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    if (!automationTasks) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "automation tasks are unavailable" });
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    if (!store.getAccountSummary(id)) {
      return reply.code(404).header("cache-control", "no-store").send({ detail: "account was not found" });
    }
    if (!store.getCloudflareMailboxCredential(id)) {
      return reply.code(409).header("cache-control", "no-store").send({ detail: "account has no stored Cloudflare Temp Mail inbox; start device login instead" });
    }
    const body = requestBody(request);
    const browser = body.browser;
    if (!browser || Array.isArray(browser) || typeof browser !== "object") {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "browser task configuration is required" });
    }
    const idempotencyKey = typeof body.idempotency_key === "string" && body.idempotency_key.trim()
      ? body.idempotency_key.trim()
      : `sso_email_reauth:${id}:${randomUUID()}`;
    const task = automationTasks.enqueue("sso_email_reauth", idempotencyKey, { accountId: id, browser });
    return reply.code(202).header("cache-control", "no-store").send({ ok: true, task: publicTask(task) });
  });
  app.get("/admin/api/accounts/register/availability", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    return reply.header("cache-control", "no-store").send({
      ok: registrationAvailable,
      provider: "cloudflare_temp_mail",
      defaults: {
        mail_base_url: options.registrationDefaults?.mailBaseUrl ?? null,
        mail_domain: options.registrationDefaults?.mailDomain ?? null,
        proxy_configured: options.registrationDefaults?.proxyConfigured ?? false,
        mail_configured: Boolean(options.registrationDefaults?.mailBaseUrl),
      },
      ...(registrationAvailable ? {} : { detail: "registration mail or dedicated proxy is not configured" }),
    });
  });
  app.get("/admin/api/automation/tasks", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    if (!automationTasks) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "automation tasks are unavailable" });
    }
    const query = request.query as { status?: unknown; limit?: unknown };
    const status = typeof query.status === "string" && ["queued", "leased", "running", "waiting_input", "succeeded", "failed", "cancelled"].includes(query.status)
      ? query.status as AutomationTask["status"]
      : undefined;
    const requestedLimit = typeof query.limit === "string" && /^\d+$/.test(query.limit) ? Number(query.limit) : undefined;
    const tasks = automationTasks.list({ ...(status ? { status } : {}), ...(requestedLimit ? { limit: requestedLimit } : {}) });
    return reply.header("cache-control", "no-store").send({ ok: true, tasks: tasks.map(publicTask), count: tasks.length });
  });
  app.get("/admin/api/automation/tasks/:id", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    if (!automationTasks) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "automation tasks are unavailable" });
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    const task = automationTasks.get(id);
    return task
      ? reply.header("cache-control", "no-store").send({ ok: true, task: publicTask(task), events: automationTasks.events(id) })
      : reply.code(404).header("cache-control", "no-store").send({ detail: "automation task was not found" });
  });
  app.post("/admin/api/automation/tasks/:id/cancel", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    if (!automationTasks) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "automation tasks are unavailable" });
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    const task = automationTasks.get(id);
    if (!task) {
      return reply.code(404).header("cache-control", "no-store").send({ detail: "automation task was not found" });
    }
    if (task.status === "running") {
      if (!automationWorker?.cancel(id)) {
        return reply.code(409).header("cache-control", "no-store").send({ detail: "running task is no longer owned by this worker" });
      }
      return reply.code(202).header("cache-control", "no-store").send({ ok: true, stopping: true, task: publicTask(task) });
    }
    if (task.status !== "queued" && task.status !== "waiting_input") {
      return reply.code(409).header("cache-control", "no-store").send({ detail: `automation task cannot be cancelled while ${task.status}` });
    }
    return reply.header("cache-control", "no-store").send({ ok: true, task: publicTask(automationTasks.cancelPending(id)) });
  });

  for (const path of ["/v1/models", "/models"]) {
    app.get(path, async (request, reply) => {
      const auth = requireApiKey(request.headers, apiKeyAuth, apiKeyStore);
      if (!auth.ok) {
        return reply.code(401).header("cache-control", "no-store").send({ detail: auth.detail });
      }
      return reply.header("cache-control", "no-store").send(openAiModelList(modelStore, defaultModel));
    });
  }

  for (const path of ["/v1/chat/completions", "/chat/completions"]) {
    app.post(path, async (request, reply) => {
      const auth = requireApiKey(request.headers, apiKeyAuth, apiKeyStore);
      if (!auth.ok) {
        return reply.code(401).header("cache-control", "no-store").send({ detail: auth.detail });
      }
      if (!chatService) {
        return reply.code(503).header("cache-control", "no-store").send({ detail: "chat service unavailable" });
      }
      try {
        const body = withGrokConversationHint(request, requestBody(request));
        if (body.stream === true) {
          beginSse(reply);
          try {
            for await (const frame of chatService.stream(body, { requestId: randomUUID(), apiKeyId: auth.apiKeyId, protocol: "chat_completions" })) {
              writeSse(reply, frame.done ? "data: [DONE]\n\n" : `data: ${frame.data}\n\n`);
            }
          } finally {
            reply.raw.end();
          }
          return reply;
        }
        return reply.header("cache-control", "no-store").send((await chatService.complete(body, {
          requestId: randomUUID(), apiKeyId: auth.apiKeyId, protocol: "chat_completions",
        })).payload);
      } catch (error) {
        return reply.code(statusFor(error)).header("cache-control", "no-store").send({ detail: messageFor(error) });
      }
    });
  }

  for (const path of ["/v1/responses", "/responses"]) {
    app.post(path, async (request, reply) => {
      const auth = requireApiKey(request.headers, apiKeyAuth, apiKeyStore);
      if (!auth.ok) {
        return reply.code(401).header("cache-control", "no-store").send({ detail: auth.detail });
      }
      if (!chatService) {
        return reply.code(503).header("cache-control", "no-store").send({ detail: "chat service unavailable" });
      }
      try {
        const raw = withGrokConversationHint(request, requestBody(request));
        const chatBody = responsesToChatBody(raw, defaultModel);
        if (!Array.isArray(chatBody.messages) || chatBody.messages.length === 0) {
          return reply.code(400).header("cache-control", "no-store").send({
            error: { message: "input must contain at least one message", type: "invalid_request_error" },
          });
        }
        if (raw.stream !== true) {
          return reply.header("cache-control", "no-store").send(buildResponseObject((await chatService.complete(chatBody, {
            requestId: randomUUID(), apiKeyId: auth.apiKeyId, protocol: "responses",
          })).payload, raw));
        }

        const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
        const encoder = new ResponsesLiveEncoder(responseId, typeof chatBody.model === "string" ? chatBody.model : defaultModel, raw);
        beginSse(reply);
        try {
          for (const frame of encoder.start()) {
            writeSse(reply, frame);
          }
          try {
            for await (const frame of chatService.stream(chatBody, {
              requestId: randomUUID(), apiKeyId: auth.apiKeyId, protocol: "responses",
            })) {
              if (!frame.done) {
                for (const output of encoder.feed(frame.data)) {
                  writeSse(reply, output);
                }
              }
            }
            for (const frame of encoder.complete()) {
              writeSse(reply, frame);
            }
          } catch (error) {
            for (const frame of encoder.fail(messageFor(error))) {
              writeSse(reply, frame);
            }
          }
        } finally {
          reply.raw.end();
        }
        return reply;
      } catch (error) {
        return reply.code(statusFor(error)).header("cache-control", "no-store").send({ detail: messageFor(error) });
      }
    });
  }

  return fastifyHealthServer(app);
}

function fastifyHealthServer(app: FastifyInstance): HealthServer {
  return {
    async listen(host: string, port: number): Promise<number> {
      await app.listen({ host, port });
      const address = app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("API server did not expose a TCP port");
      }
      return address.port;
    },
    close(): Promise<void> {
      return app.close();
    },
  };
}

export function createHealthServer(): HealthServer {
  return createApiServer();
}

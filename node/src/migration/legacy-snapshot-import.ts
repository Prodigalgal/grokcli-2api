import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { supportedSettings } from "./unsupported-integration-settings.js";
import type { ApiKeySnapshotInput, ModelSnapshotInput, PoolSnapshotInput, SqliteStore } from "../storage/sqlite-store.js";

export interface LegacySnapshot {
  readonly schema_version: 1;
  readonly source?: string;
  readonly exported_at?: number;
  readonly accounts: readonly Record<string, unknown>[];
  readonly account_pool?: readonly Record<string, unknown>[];
  readonly api_keys?: readonly Record<string, unknown>[];
  readonly models?: readonly Record<string, unknown>[];
  readonly settings?: Record<string, unknown>;
}

export interface SnapshotImportReport {
  readonly source: string;
  readonly accounts: number;
  readonly pools: number;
  readonly apiKeys: number;
  readonly models: number;
  readonly settings: number;
  readonly skippedUnsupportedSettings: number;
  readonly inventorySha256: string;
  readonly credentialsSha256: string;
}

export function loadLegacySnapshot(path: string): LegacySnapshot {
  return parseSnapshot(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function importLegacySnapshot(store: SqliteStore, snapshot: LegacySnapshot, now = Date.now()): SnapshotImportReport {
  const accounts = snapshot.accounts.map((account) => accountInput(account));
  const pools = rootPools(snapshot, accounts);
  const apiKeys = (snapshot.api_keys ?? []).map(apiKeyInput);
  const models = (snapshot.models ?? []).map(modelInput);
  const { accepted: settings, skipped: skippedUnsupportedSettings } = supportedSettings(snapshot.settings ?? {});
  const ids = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) {
      throw new Error(`snapshot contains duplicate account id ${account.id}`);
    }
    ids.add(account.id);
  }
  for (const pool of pools) {
    if (!ids.has(pool.accountId)) {
      throw new Error(`snapshot pool references unknown account ${pool.accountId}`);
    }
  }
  store.transaction(() => {
    for (const account of accounts) {
      store.saveAccount(account, now);
    }
    for (const pool of pools) {
      store.applyPoolSnapshot(pool, now);
    }
    store.replaceApiKeySnapshot(apiKeys);
    store.replaceModelSnapshot(models, now);
    store.replaceSettingsSnapshot(settings, now);
  });
  const inventory = createHash("sha256");
  const credentials = createHash("sha256");
  for (const account of [...accounts].sort((left, right) => left.id.localeCompare(right.id))) {
    inventory.update(`${account.id}\u0000${account.email ?? ""}\u0000${account.userId ?? ""}\u0000${account.teamId ?? ""}\n`);
    credentials.update(`${account.id}\u0000${hash(canonicalJson(account.payload))}\n`);
  }
  for (const key of [...apiKeys].sort((left, right) => left.id.localeCompare(right.id))) {
    inventory.update(`key\u0000${key.id}\u0000${key.enabled ? "1" : "0"}\n`);
    credentials.update(`key\u0000${key.id}\u0000${key.keyHash}\n`);
  }
  for (const model of [...models].sort((left, right) => left.id.localeCompare(right.id))) {
    inventory.update(`model\u0000${model.id}\u0000${model.hidden ? "1" : "0"}\n`);
  }
  return {
    source: snapshot.source ?? "legacy-snapshot",
    accounts: accounts.length,
    pools: pools.length,
    apiKeys: apiKeys.length,
    models: models.length,
    settings: Object.keys(settings).length,
    skippedUnsupportedSettings,
    inventorySha256: inventory.digest("hex"),
    credentialsSha256: credentials.digest("hex"),
  };
}

function parseSnapshot(value: unknown): LegacySnapshot {
  const root = record(value, "legacy snapshot");
  if (root.schema_version !== 1) {
    throw new Error("legacy snapshot schema_version must be 1");
  }
  const accounts = records(root.accounts, "legacy snapshot.accounts");
  const output: LegacySnapshot = {
    schema_version: 1,
    accounts,
    ...(optionalString(root.source) ? { source: optionalString(root.source)! } : {}),
    ...(epoch(root.exported_at) !== null ? { exported_at: epoch(root.exported_at)! } : {}),
    ...(root.account_pool === undefined ? {} : { account_pool: records(root.account_pool, "legacy snapshot.account_pool") }),
    ...(root.api_keys === undefined ? {} : { api_keys: records(root.api_keys, "legacy snapshot.api_keys") }),
    ...(root.models === undefined ? {} : { models: records(root.models, "legacy snapshot.models") }),
    ...(root.settings === undefined ? {} : { settings: record(root.settings, "legacy snapshot.settings") }),
  };
  return output;
}

function accountInput(value: Record<string, unknown>) {
  const id = requiredString(value.id, "account.id");
  const payload = record(value.payload ?? value.entry, `account ${id}.payload`);
  return {
    id,
    email: optionalString(value.email) ?? optionalString(payload.email),
    userId: optionalString(value.user_id) ?? optionalString(value.userId) ?? optionalString(payload.user_id) ?? optionalString(payload.principal_id),
    teamId: optionalString(value.team_id) ?? optionalString(value.teamId) ?? optionalString(payload.team_id),
    payload,
    expiresAt: epoch(value.expires_at ?? value.expiresAt ?? payload.expires_at),
  };
}

function rootPools(snapshot: LegacySnapshot, accounts: readonly ReturnType<typeof accountInput>[]): PoolSnapshotInput[] {
  const embedded = accounts.flatMap((account, index) => {
    const raw = snapshot.accounts[index]?.pool;
    return raw === undefined ? [] : [poolInput(record(raw, `account ${account.id}.pool`), account.id)];
  });
  const root = (snapshot.account_pool ?? []).map((value) => poolInput(value));
  return root.length > 0 ? root : embedded;
}

function poolInput(value: Record<string, unknown>, fallbackId?: string): PoolSnapshotInput {
  return {
    accountId: requiredString(value.account_id ?? value.accountId ?? fallbackId, "pool.account_id"),
    enabled: booleanValue(value.enabled, true),
    weight: nonNegative(value.weight, 1),
    disabledForQuota: booleanValue(value.disabled_for_quota ?? value.disabledForQuota, false),
    disabledReason: optionalString(value.disabled_reason ?? value.disabledReason),
    quotaDisabledAt: epoch(value.quota_disabled_at ?? value.quotaDisabledAt),
    quotaSource: optionalString(value.quota_source ?? value.quotaSource),
    lastQuota: optionalRecord(value.last_quota ?? value.lastQuota) ?? {},
    lastProbe: optionalRecord(value.last_probe ?? value.lastProbe) ?? {},
    blockedModels: optionalRecord(value.blocked_models ?? value.blockedModels) ?? {},
    requestCount: nonNegative(value.request_count ?? value.requestCount, 0),
    successCount: nonNegative(value.success_count ?? value.successCount, 0),
    failCount: nonNegative(value.fail_count ?? value.failCount, 0),
    lastUsedAt: epoch(value.last_used_at ?? value.lastUsedAt),
    lastError: optionalString(value.last_error ?? value.lastError),
    cooldownUntil: epoch(value.cooldown_until ?? value.cooldownUntil),
    poolStatus: optionalString(value.pool_status ?? value.poolStatus) ?? "normal",
    extra: optionalRecord(value.extra) ?? {},
  };
}

function apiKeyInput(value: Record<string, unknown>): ApiKeySnapshotInput {
  const keyHash = requiredString(value.key_hash ?? value.keyHash, "api_key.key_hash");
  if (!/^[a-f0-9]{64}$/i.test(keyHash)) {
    throw new Error("api_key.key_hash must be a SHA-256 hex digest");
  }
  return {
    id: requiredString(value.id, "api_key.id"),
    name: optionalString(value.name) ?? "unnamed",
    prefix: optionalString(value.prefix) ?? "",
    keyHash: keyHash.toLowerCase(),
    enabled: booleanValue(value.enabled, true),
    note: optionalString(value.note) ?? "",
    createdAt: epoch(value.created_at ?? value.createdAt) ?? 0,
    lastUsedAt: epoch(value.last_used_at ?? value.lastUsedAt),
    requestCount: nonNegative(value.request_count ?? value.requestCount, 0),
    promptTokensTotal: nonNegative(value.prompt_tokens_total ?? value.promptTokensTotal, 0),
    completionTokensTotal: nonNegative(value.completion_tokens_total ?? value.completionTokensTotal, 0),
    totalTokensTotal: nonNegative(value.total_tokens_total ?? value.totalTokensTotal, 0),
  };
}

function modelInput(value: Record<string, unknown>): ModelSnapshotInput {
  return {
    id: requiredString(value.id, "model.id"),
    name: optionalString(value.name),
    description: optionalString(value.description),
    ownedBy: optionalString(value.owned_by ?? value.ownedBy) ?? "xai",
    hidden: booleanValue(value.hidden, false),
    synthetic: booleanValue(value.synthetic, false),
    contextWindow: positiveOrNull(value.context_window ?? value.contextWindow),
    supportsReasoningEffort: optionalBoolean(value.supports_reasoning_effort ?? value.supportsReasoningEffort),
    extra: optionalRecord(value.extra) ?? {},
    sortOrder: nonNegative(value.sort_order ?? value.sortOrder, 100),
    fetchedAt: epoch(value.fetched_at ?? value.fetchedAt),
  };
}

function records(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => record(item, `${field}[${index}]`));
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : record(value, "snapshot object");
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  return value === true || value === 1 || (typeof value === "string" && ["1", "true", "yes"].includes(value.trim().toLowerCase()));
}

function optionalBoolean(value: unknown): boolean | null {
  return value === undefined || value === null ? null : booleanValue(value, false);
}

function nonNegative(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(0, parsed);
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

function epoch(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  if (!Number.isSafeInteger(Math.trunc(milliseconds))) {
    throw new Error("snapshot epoch is outside the supported range");
  }
  return Math.trunc(milliseconds);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("snapshot contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = record(value, "snapshot JSON value");
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

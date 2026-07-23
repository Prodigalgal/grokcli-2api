import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isUnsupportedIntegrationSetting } from "./unsupported-integration-settings.js";

export interface PostgresQueryResult<T> {
  readonly rows: readonly T[];
}

export interface PostgresSnapshotSource {
  query<T extends Record<string, unknown>>(sql: string): Promise<PostgresQueryResult<T>>;
}

export interface PostgresSnapshotReport {
  readonly accounts: number;
  readonly pools: number;
  readonly apiKeys: number;
  readonly models: number;
  readonly settings: number;
  readonly skippedUnsupportedSettings: number;
  readonly inventorySha256: string;
}

export interface PostgresSnapshotExport {
  readonly snapshot: Record<string, unknown>;
  readonly report: PostgresSnapshotReport;
}

export async function exportLegacyPostgresSnapshot(source: PostgresSnapshotSource): Promise<PostgresSnapshotExport> {
  const [accountsResult, keysResult, modelsResult, settingsResult] = await Promise.all([
    source.query<Record<string, unknown>>(`
      SELECT a.id, a.email, a.user_id, a.team_id, a.payload,
             EXTRACT(EPOCH FROM a.expires_at) AS expires_at,
             ap.enabled, ap.weight, ap.disabled_for_quota, ap.disabled_reason,
             EXTRACT(EPOCH FROM ap.quota_disabled_at) AS quota_disabled_at,
             ap.quota_source, ap.last_quota, ap.last_probe, ap.blocked_models,
             ap.request_count, ap.success_count, ap.fail_count,
             EXTRACT(EPOCH FROM ap.last_used_at) AS last_used_at, ap.last_error,
             EXTRACT(EPOCH FROM ap.cooldown_until) AS cooldown_until,
             ap.pool_status, ap.extra
      FROM accounts a
      LEFT JOIN account_pool ap ON ap.account_id = a.id
      ORDER BY a.id
    `),
    source.query<Record<string, unknown>>(`
      SELECT id, name, prefix, key_hash, enabled, note,
             EXTRACT(EPOCH FROM created_at) AS created_at,
             EXTRACT(EPOCH FROM last_used_at) AS last_used_at,
             request_count, prompt_tokens_total, completion_tokens_total, total_tokens_total
      FROM api_keys ORDER BY id
    `),
    source.query<Record<string, unknown>>(`
      SELECT id, name, description, owned_by, hidden, synthetic,
             context_window, supports_reasoning_effort, extra, sort_order,
             EXTRACT(EPOCH FROM fetched_at) AS fetched_at
      FROM models ORDER BY sort_order, id
    `),
    source.query<Record<string, unknown>>("SELECT key, value FROM app_settings ORDER BY key"),
  ]);
  const accounts: Record<string, unknown>[] = [];
  const pools: Record<string, unknown>[] = [];
  for (const row of accountsResult.rows) {
    const id = text(row.id);
    if (!id) {
      throw new Error("PostgreSQL export encountered an account without id");
    }
    accounts.push({
      id,
      email: nullableText(row.email),
      user_id: nullableText(row.user_id),
      team_id: nullableText(row.team_id),
      payload: object(row.payload),
      expires_at: epoch(row.expires_at),
    });
    if (row.enabled !== null && row.enabled !== undefined) {
      pools.push({
        account_id: id,
        enabled: boolean(row.enabled, true),
        weight: number(row.weight, 1),
        disabled_for_quota: boolean(row.disabled_for_quota, false),
        disabled_reason: nullableText(row.disabled_reason),
        quota_disabled_at: epoch(row.quota_disabled_at),
        quota_source: nullableText(row.quota_source),
        last_quota: object(row.last_quota),
        last_probe: object(row.last_probe),
        blocked_models: object(row.blocked_models),
        request_count: number(row.request_count, 0),
        success_count: number(row.success_count, 0),
        fail_count: number(row.fail_count, 0),
        last_used_at: epoch(row.last_used_at),
        last_error: nullableText(row.last_error),
        cooldown_until: epoch(row.cooldown_until),
        pool_status: nullableText(row.pool_status) ?? "normal",
        extra: object(row.extra),
      });
    }
  }
  const settings: Record<string, unknown> = {};
  let skippedUnsupportedSettings = 0;
  for (const row of settingsResult.rows) {
    const key = text(row.key);
    if (key) {
      if (isUnsupportedIntegrationSetting(key)) {
        skippedUnsupportedSettings += 1;
      } else {
        settings[key] = jsonValue(row.value);
      }
    }
  }
  const snapshot = {
    schema_version: 1,
    source: "legacy-postgres",
    exported_at: Date.now(),
    accounts,
    account_pool: pools,
    api_keys: keysResult.rows.map((row) => ({
      id: text(row.id), name: text(row.name) || "unnamed", prefix: text(row.prefix),
      key_hash: text(row.key_hash), enabled: boolean(row.enabled, true), note: text(row.note),
      created_at: epoch(row.created_at) ?? 0, last_used_at: epoch(row.last_used_at),
      request_count: number(row.request_count, 0), prompt_tokens_total: number(row.prompt_tokens_total, 0),
      completion_tokens_total: number(row.completion_tokens_total, 0), total_tokens_total: number(row.total_tokens_total, 0),
    })),
    models: modelsResult.rows.map((row) => ({
      id: text(row.id), name: nullableText(row.name), description: nullableText(row.description),
      owned_by: text(row.owned_by) || "xai", hidden: boolean(row.hidden, false), synthetic: boolean(row.synthetic, false),
      context_window: positiveOrNull(row.context_window), supports_reasoning_effort: nullableBoolean(row.supports_reasoning_effort),
      extra: object(row.extra), sort_order: number(row.sort_order, 100), fetched_at: epoch(row.fetched_at),
    })),
    settings,
  };
  const inventory = createHash("sha256");
  for (const account of accounts) {
    inventory.update(`${account.id}\u0000${account.email ?? ""}\u0000${account.user_id ?? ""}\n`);
  }
  for (const row of keysResult.rows) {
    inventory.update(`key\u0000${text(row.id)}\u0000${text(row.key_hash)}\n`);
  }
  return {
    snapshot,
    report: {
      accounts: accounts.length,
      pools: pools.length,
      apiKeys: keysResult.rows.length,
      models: modelsResult.rows.length,
      settings: Object.keys(settings).length,
      skippedUnsupportedSettings,
      inventorySha256: inventory.digest("hex"),
    },
  };
}

export function writePrivateSnapshot(path: string, snapshot: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown): string | null {
  return text(value) || null;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function epoch(value: unknown): number | null {
  const parsed = number(value, 0);
  return parsed > 0 ? parsed : null;
}

function positiveOrNull(value: unknown): number | null {
  const parsed = number(value, 0);
  return parsed > 0 ? Math.trunc(parsed) : null;
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  return value === true || value === 1 || (typeof value === "string" && ["1", "true", "yes"].includes(value.trim().toLowerCase()));
}

function nullableBoolean(value: unknown): boolean | null {
  return value === undefined || value === null ? null : boolean(value, false);
}

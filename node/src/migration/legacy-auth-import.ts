import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { SqliteStore } from "../storage/sqlite-store.js";

export interface LegacyAuthExport {
  readonly source?: string;
  readonly exported_at?: number;
  readonly auth: Record<string, Record<string, unknown>>;
}

export interface LegacyImportReport {
  readonly source: string;
  readonly imported: number;
  readonly totalAccounts: number;
  readonly inventorySha256: string;
  readonly credentialsSha256: string;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalEpochMilliseconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  if (!Number.isSafeInteger(Math.trunc(milliseconds))) {
    throw new Error("expires_at is outside the supported range");
  }
  return Math.trunc(milliseconds);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("legacy JSON contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = asRecord(value, "legacy JSON value");
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function parseExport(value: unknown): LegacyAuthExport {
  const root = asRecord(value, "legacy auth export");
  const auth = asRecord(root.auth, "legacy auth export.auth");
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [id, entry] of Object.entries(auth)) {
    if (!id.trim()) {
      throw new Error("legacy auth export contains an empty account id");
    }
    normalized[id] = asRecord(entry, `legacy auth export.auth.${id}`);
  }
  const output: LegacyAuthExport = { auth: normalized };
  const source = optionalString(root.source);
  if (source) {
    Object.assign(output, { source });
  }
  if (typeof root.exported_at === "number" && Number.isFinite(root.exported_at)) {
    Object.assign(output, { exported_at: root.exported_at });
  }
  return output;
}

export function loadLegacyAuthExport(path: string): LegacyAuthExport {
  return parseExport(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function importLegacyAuthExport(store: SqliteStore, input: LegacyAuthExport, now = Date.now()): LegacyImportReport {
  const records = Object.entries(input.auth).sort(([left], [right]) => left.localeCompare(right));
  const inventory = createHash("sha256");
  const credentials = createHash("sha256");
  for (const [id, entry] of records) {
    const email = optionalString(entry.email);
    const userId = optionalString(entry.user_id) ?? optionalString(entry.principal_id);
    const teamId = optionalString(entry.team_id);
    store.saveAccount({
      id,
      email,
      userId,
      teamId,
      payload: entry,
      expiresAt: optionalEpochMilliseconds(entry.expires_at),
    }, now);
    inventory.update(`${id}\u0000${email ?? ""}\u0000${userId ?? ""}\u0000${teamId ?? ""}\n`);
    credentials.update(`${id}\u0000${createHash("sha256").update(canonicalJson(entry)).digest("hex")}\n`);
  }
  return {
    source: input.source ?? "legacy-auth-export",
    imported: records.length,
    totalAccounts: store.countAccounts(),
    inventorySha256: inventory.digest("hex"),
    credentialsSha256: credentials.digest("hex"),
  };
}

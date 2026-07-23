import { createHash, timingSafeEqual } from "node:crypto";

export interface ApiKeyStore {
  hasEnabledApiKeys(): boolean;
  findEnabledApiKeyByHash(hash: string): { readonly id: string } | null;
  touchApiKeyUsage(id: string, now?: number): void;
}

export interface ApiKeyAuthConfig {
  readonly legacyApiKey: string | null;
  readonly requireApiKey: "auto" | "on" | "off";
}

export type ApiKeyAuthResult =
  | { readonly ok: true; readonly apiKeyId: string | null }
  | { readonly ok: false; readonly detail: string };

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestToken(headers: Record<string, string | string[] | undefined>): string {
  const authorization = headers.authorization;
  const bearer = Array.isArray(authorization) ? authorization[0] : authorization;
  if (bearer?.toLowerCase().startsWith("bearer ")) {
    return bearer.slice(7).trim();
  }
  const apiKey = headers["x-api-key"];
  return (Array.isArray(apiKey) ? apiKey[0] : apiKey)?.trim() ?? "";
}

export function requireApiKey(
  headers: Record<string, string | string[] | undefined>,
  config: ApiKeyAuthConfig,
  store: ApiKeyStore | null,
  now = Date.now(),
): ApiKeyAuthResult {
  const token = requestToken(headers);
  const required = config.requireApiKey === "on"
    || (config.requireApiKey === "auto" && (config.legacyApiKey !== null || store?.hasEnabledApiKeys() === true));
  if (!token) {
    return required ? { ok: false, detail: "Invalid or missing API key" } : { ok: true, apiKeyId: null };
  }
  if (config.legacyApiKey !== null && equal(token, config.legacyApiKey)) {
    return { ok: true, apiKeyId: "env" };
  }
  const key = store?.findEnabledApiKeyByHash(hashKey(token)) ?? null;
  if (!key) {
    return { ok: false, detail: "Invalid or missing API key" };
  }
  store?.touchApiKeyUsage(key.id, now);
  return { ok: true, apiKeyId: key.id };
}

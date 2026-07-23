import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { AccountInput, DeviceLoginSession, SqliteStore } from "../storage/sqlite-store.js";

export interface DeviceLoginServiceOptions {
  readonly store: SqliteStore;
  readonly config: Pick<AppConfig, "oidcDeviceUrl" | "oidcTokenUrl" | "oidcClientId" | "oidcScopes">;
  readonly fetchImpl?: typeof fetch;
  readonly autoPoll?: boolean;
}

export class DeviceLoginService {
  private readonly fetchImpl: typeof fetch;
  private readonly activePolls = new Set<string>();
  private readonly autoPoll: boolean;

  constructor(private readonly options: DeviceLoginServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.autoPoll = options.autoPoll ?? true;
  }

  async start(targetAccountId?: string): Promise<DeviceLoginSession> {
    const response = await this.fetchImpl(this.options.config.oidcDeviceUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.options.config.oidcClientId, scope: this.options.config.oidcScopes }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`device code request failed: HTTP ${response.status}`);
    }
    const data = objectJson(body, "device code response");
    const deviceCode = stringValue(data.device_code);
    const userCode = stringValue(data.user_code).toUpperCase();
    if (!deviceCode || !userCode) {
      throw new Error("device code response is missing device_code or user_code");
    }
    const verificationUrl = stringValue(data.verification_uri_complete)
      || stringValue(data.verification_uri)
      || "https://accounts.x.ai/oauth2/device";
    const intervalSeconds = boundedNumber(data.interval, 5, 3, 30);
    const expiresSeconds = boundedNumber(data.expires_in, 1_800, 60, 7_200);
    const session = this.options.store.createDeviceLoginSession({
      id: randomUUID(),
      deviceCode,
      userCode,
      verificationUrl,
      clientId: this.options.config.oidcClientId,
      pollingIntervalMs: intervalSeconds * 1_000,
      targetAccountId: targetAccountId?.trim() || null,
      expiresAt: Date.now() + expiresSeconds * 1_000,
      message: "Waiting for device authorization",
    });
    if (this.autoPoll) {
      this.schedulePoll(session.id, 0);
    }
    return session;
  }

  resume(): void {
    if (!this.autoPoll) {
      return;
    }
    for (const id of this.options.store.listActiveDeviceLoginSessionIds()) {
      this.schedulePoll(id, 0);
    }
  }

  get(id: string): DeviceLoginSession | null {
    return this.options.store.getDeviceLoginSession(id);
  }

  list(): DeviceLoginSession[] {
    return this.options.store.listDeviceLoginSessions();
  }

  async pollOnce(id: string): Promise<DeviceLoginSession | null> {
    const session = this.options.store.getDeviceLoginSessionForPolling(id);
    if (!session || terminal(session.status)) {
      return session;
    }
    if (session.expiresAt <= Date.now()) {
      return this.options.store.updateDeviceLoginSession(id, {
        status: "expired",
        message: "Device code expired; start a new login",
        error: "expired_token",
        finishedAt: Date.now(),
      });
    }
    const response = await this.fetchImpl(this.options.config.oidcTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: session.deviceCode,
        client_id: session.clientId,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const data = tryObjectJson(text);
    if (response.ok && stringValue(data?.access_token)) {
      const account = this.restoreTokens(session.targetAccountId, data!, session.clientId);
      return this.options.store.updateDeviceLoginSession(id, {
        status: "succeeded",
        accountId: account.id,
        email: account.email ?? null,
        message: "Device login completed",
        error: null,
        finishedAt: Date.now(),
      });
    }
    const code = stringValue(data?.error);
    if (code === "authorization_pending") {
      return this.options.store.updateDeviceLoginSession(id, {
        status: "waiting_user",
        message: "Waiting for device authorization",
        error: null,
      });
    }
    if (code === "slow_down") {
      return this.options.store.updateDeviceLoginSession(id, {
        status: "waiting_user",
        pollingIntervalMs: Math.min(session.pollingIntervalMs + 5_000, 30_000),
        message: "Authorization service asked the client to slow down",
        error: null,
      });
    }
    if (code === "expired_token") {
      return this.options.store.updateDeviceLoginSession(id, {
        status: "expired",
        message: "Device code expired; start a new login",
        error: code,
        finishedAt: Date.now(),
      });
    }
    if (code === "access_denied") {
      return this.options.store.updateDeviceLoginSession(id, {
        status: "failed",
        message: "Device authorization was denied",
        error: code,
        finishedAt: Date.now(),
      });
    }
    if (!response.ok && code) {
      return this.options.store.updateDeviceLoginSession(id, {
        status: "failed",
        message: "Device authorization failed",
        error: `${code}${stringValue(data?.error_description) ? `: ${stringValue(data?.error_description).slice(0, 200)}` : ""}`,
        finishedAt: Date.now(),
      });
    }
    return this.options.store.updateDeviceLoginSession(id, {
      status: "waiting_user",
      message: `Waiting for authorization (${response.status})`,
      error: null,
    });
  }

  private schedulePoll(id: string, delayMs: number): void {
    if (this.activePolls.has(id)) {
      return;
    }
    this.activePolls.add(id);
    const timer = setTimeout(async () => {
      try {
        const session = await this.pollOnce(id);
        if (session && !terminal(session.status)) {
          this.activePolls.delete(id);
          this.schedulePoll(id, session.pollingIntervalMs);
          return;
        }
      } catch {
        const existing = this.options.store.getDeviceLoginSession(id);
        if (existing && !terminal(existing.status)) {
          this.options.store.updateDeviceLoginSession(id, {
            status: "waiting_user",
            message: "Temporary polling failure; retrying",
            error: null,
          });
          this.activePolls.delete(id);
          this.schedulePoll(id, existing.pollingIntervalMs);
          return;
        }
      }
      this.activePolls.delete(id);
    }, delayMs);
    timer.unref();
  }

  restoreTokens(targetAccountId: string | null, tokenData: Record<string, unknown>, clientId: string): AccountInput {
    const accessToken = stringValue(tokenData.access_token);
    const claims = decodeJwtClaims(accessToken);
    const userId = stringValue(claims.principal_id) || stringValue(claims.sub) || stringValue(tokenData.sub) || null;
    const accountId = targetAccountId || (userId ? `https://auth.x.ai::${userId}` : `https://auth.x.ai::${clientId}`);
    const previous = this.options.store.getAccount(accountId);
    const payload: Record<string, unknown> = { ...(previous?.payload ?? {}), key: accessToken };
    if (typeof previous?.payload.access_token === "string") {
      payload.access_token = accessToken;
    }
    if (stringValue(tokenData.refresh_token)) {
      payload.refresh_token = stringValue(tokenData.refresh_token);
    }
    if (stringValue(tokenData.id_token)) {
      payload.id_token = stringValue(tokenData.id_token);
    }
    if (userId) {
      payload.user_id = userId;
      payload.principal_id = userId;
    }
    const email = previous?.email ?? (stringValue(claims.email) || stringValue(tokenData.email) || null);
    const teamId = previous?.teamId ?? (stringValue(claims.team_id) || null);
    if (email) {
      payload.email = email;
    }
    if (teamId) {
      payload.team_id = teamId;
    }
    payload.source = targetAccountId ? "device-relogin" : "device-login";
    payload.auth_mode = "oidc";
    delete payload.refresh_invalid;
    delete payload.refresh_invalid_reason;
    delete payload.refresh_invalid_at;
    return this.options.store.recordRefreshSuccess({
      id: accountId,
      email,
      userId: previous?.userId ?? userId,
      teamId,
      payload,
      expiresAt: expiryMilliseconds(tokenData, accessToken, previous?.expiresAt ?? null),
    });
  }
}

function terminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "expired";
}

function objectJson(text: string, label: string): Record<string, unknown> {
  const parsed = tryObjectJson(text);
  if (!parsed) {
    throw new Error(`${label} was not valid JSON`);
  }
  return parsed;
}

function tryObjectJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(value)))
    : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const segment = token.split(".")[1];
  if (!segment) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function expiryMilliseconds(tokenData: Record<string, unknown>, accessToken: string, previous: number | null): number | null {
  const expiresIn = tokenData.expires_in;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return expiresIn < 100_000_000_000 ? Date.now() + expiresIn * 1_000 : Math.trunc(expiresIn);
  }
  const claims = decodeJwtClaims(accessToken);
  if (typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > 0) {
    return claims.exp < 100_000_000_000 ? Math.trunc(claims.exp * 1_000) : Math.trunc(claims.exp);
  }
  return previous;
}

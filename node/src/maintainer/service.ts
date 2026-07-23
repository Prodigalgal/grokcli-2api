import type { AppConfig } from "../config.js";
import type { AccountInput, MaintenanceCandidate, SqliteStore } from "../storage/sqlite-store.js";
import { OidcRefreshClient, OidcRefreshError } from "./oidc-refresh.js";

export interface MaintenanceResult {
  readonly attempted: number;
  readonly refreshed: number;
  readonly failed: number;
  readonly permanentFailures: number;
  readonly ssoTasksQueued: number;
}

export interface MaintainerOptions {
  readonly store: SqliteStore;
  readonly config: Pick<AppConfig,
    "tokenMaintainerIntervalMs" | "tokenRefreshBatch" | "tokenRefreshWorkers" |
    "tokenRefreshSkewMs" | "oidcTokenUrl" | "oidcClientId">;
  readonly oidcClient?: OidcRefreshClient;
}

export class TokenMaintainer {
  private readonly client: OidcRefreshClient;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: MaintainerOptions) {
    this.client = options.oidcClient ?? new OidcRefreshClient({
      tokenUrl: options.config.oidcTokenUrl,
      clientId: options.config.oidcClientId,
    });
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const firstRun = setTimeout(() => void this.runOnce(), 3_000);
    firstRun.unref();
    this.timer = setInterval(() => void this.runOnce(), this.options.config.tokenMaintainerIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(force = false): Promise<MaintenanceResult> {
    if (this.running) {
      return { attempted: 0, refreshed: 0, failed: 0, permanentFailures: 0, ssoTasksQueued: 0 };
    }
    this.running = true;
    try {
      const candidates = this.options.store.listRefreshCandidates({
        skewMs: this.options.config.tokenRefreshSkewMs,
        limit: this.options.config.tokenRefreshBatch,
        force,
      });
      const results = await mapConcurrent(candidates, this.options.config.tokenRefreshWorkers, async (candidate) => this.refresh(candidate));
      return results.reduce<MaintenanceResult>((summary, result) => ({
        attempted: summary.attempted + 1,
        refreshed: summary.refreshed + (result.refreshed ? 1 : 0),
        failed: summary.failed + (result.refreshed ? 0 : 1),
        permanentFailures: summary.permanentFailures + (result.permanent ? 1 : 0),
        ssoTasksQueued: summary.ssoTasksQueued + (result.ssoTaskQueued ? 1 : 0),
      }), { attempted: 0, refreshed: 0, failed: 0, permanentFailures: 0, ssoTasksQueued: 0 });
    } finally {
      this.running = false;
    }
  }

  private async refresh(candidate: MaintenanceCandidate): Promise<{ refreshed: boolean; permanent: boolean; ssoTaskQueued: boolean }> {
    try {
      const refreshed = await this.client.refresh(candidate.payload);
      this.options.store.recordRefreshSuccess(accountFromRefresh(candidate, refreshed.payload, refreshed.accessToken));
      return { refreshed: true, permanent: false, ssoTaskQueued: false };
    } catch (error) {
      const permanent = error instanceof OidcRefreshError && error.permanent;
      const reason = error instanceof Error ? error.message : "token refresh failed";
      const account = this.options.store.recordRefreshFailure(candidate.id, reason, permanent);
      let ssoTaskQueued = false;
      if (permanent && hasSsoContext(account.payload)) {
        const invalidAt = typeof account.payload.refresh_invalid_at === "number" ? account.payload.refresh_invalid_at : Date.now();
        this.options.store.automationTasks().enqueue(
          "sso_reauth",
          `sso_reauth:${account.id}:${invalidAt}`,
          { accountId: account.id, trigger: "refresh_token_invalid" },
        );
        this.options.store.markSsoReauthQueued(account.id);
        ssoTaskQueued = true;
      }
      return { refreshed: false, permanent, ssoTaskQueued };
    }
  }
}

export function hasSsoContext(payload: Record<string, unknown>): boolean {
  for (const key of ["sso", "sso_cookie", "sso_token"]) {
    if (typeof payload[key] === "string" && payload[key].trim()) {
      return true;
    }
  }
  for (const key of ["session_cookies", "cookies"]) {
    const nested = payload[key];
    if (nested && !Array.isArray(nested) && typeof nested === "object") {
      const cookies = nested as Record<string, unknown>;
      if (["sso", "sso-rw"].some((name) => typeof cookies[name] === "string" && cookies[name].trim())) {
        return true;
      }
    }
  }
  return ["cookie", "cookies", "set_cookie", "set-cookie", "set_cookies"].some((key) => {
    const value = payload[key];
    return typeof value === "string" && /(?:^|[;,\s])sso(?:-rw)?\s*=\s*[^;,\s]+/i.test(value);
  });
}

function accountFromRefresh(candidate: MaintenanceCandidate, tokenData: Record<string, unknown>, accessToken: string): AccountInput {
  const payload: Record<string, unknown> = { ...candidate.payload, key: accessToken };
  if (typeof candidate.payload.access_token === "string") {
    payload.access_token = accessToken;
  }
  if (stringValue(tokenData.refresh_token)) {
    payload.refresh_token = stringValue(tokenData.refresh_token);
  }
  if (stringValue(tokenData.id_token)) {
    payload.id_token = stringValue(tokenData.id_token);
  }
  delete payload.refresh_invalid;
  delete payload.refresh_invalid_reason;
  delete payload.refresh_invalid_at;
  const claims = decodeJwtClaims(accessToken);
  const userId = candidate.userId ?? (stringValue(claims.principal_id) || stringValue(claims.sub) || stringValue(tokenData.sub) || null);
  const email = candidate.email ?? (stringValue(claims.email) || stringValue(tokenData.email) || null);
  if (userId) {
    payload.user_id = userId;
    payload.principal_id = userId;
  }
  if (email) {
    payload.email = email;
  }
  return {
    id: candidate.id,
    email,
    userId,
    teamId: candidate.teamId,
    payload,
    expiresAt: expiryFromTokenResponse(tokenData, accessToken, candidate.expiresAt),
  };
}

function expiryFromTokenResponse(tokenData: Record<string, unknown>, accessToken: string, previous: number | null): number | null {
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

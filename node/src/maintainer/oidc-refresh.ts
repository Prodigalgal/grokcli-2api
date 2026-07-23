export class OidcRefreshError extends Error {
  constructor(
    readonly status: number,
    readonly permanent: boolean,
    message: string,
  ) {
    super(message);
    this.name = "OidcRefreshError";
  }
}

export interface OidcRefreshClientOptions {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface OidcRefreshResult {
  readonly payload: Record<string, unknown>;
  readonly accessToken: string;
}

export class OidcRefreshClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OidcRefreshClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async refresh(entry: Record<string, unknown>): Promise<OidcRefreshResult> {
    if (truthy(entry.refresh_invalid)) {
      throw new OidcRefreshError(0, true, "refresh_token marked invalid");
    }
    const refreshToken = stringValue(entry.refresh_token);
    if (!refreshToken) {
      throw new OidcRefreshError(0, true, "no refresh_token on account");
    }
    const clientId = stringValue(entry.oidc_client_id) || this.options.clientId;
    const response = await this.fetchImpl(this.options.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = (await response.text()).slice(0, 64 * 1024);
    if (!response.ok) {
      const summary = summarize(response.status, text);
      throw new OidcRefreshError(response.status, isPermanent(response.status, text), summary);
    }
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("not an object");
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new OidcRefreshError(response.status, false, "OIDC refresh response was not valid JSON");
    }
    const accessToken = stringValue(payload.access_token) || stringValue(payload.key);
    if (!accessToken) {
      throw new OidcRefreshError(response.status, false, "OIDC refresh response missing access_token");
    }
    return { payload, accessToken };
  }
}

export function isPermanentRefreshFailure(status: number, body: string): boolean {
  return isPermanent(status, body);
}

function isPermanent(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) {
    return false;
  }
  const text = body.toLowerCase();
  return [
    "refresh_token has been revoked",
    "refresh_token is invalid",
    "refresh_token revoked",
    "refresh_token expired",
    "invalid_grant",
    "token has been revoked",
    "invalid refresh",
  ].some((needle) => text.includes(needle));
}

function summarize(status: number, body: string): string {
  const compact = body.replace(/\s+/g, " ").trim().slice(0, 400);
  return compact ? `refresh failed: HTTP ${status}: ${compact}` : `refresh failed: HTTP ${status}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truthy(value: unknown): boolean {
  return value === true
    || value === 1
    || (typeof value === "string" && ["1", "true", "yes"].includes(value.trim().toLowerCase()));
}

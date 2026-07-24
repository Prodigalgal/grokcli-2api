export interface PythonReauthClientOptions {
  readonly serviceUrl: string;
  readonly token: string | null;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export class PythonReauthClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PythonReauthClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async reauthenticate(email: string, password: string): Promise<string> {
    const response = await this.fetchImpl(`${this.options.serviceUrl}/internal/registration/v1/reauth`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}) },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const value = await response.json().catch(() => null) as unknown;
    const payload = value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
    if (!response.ok) {
      const detail = typeof payload.detail === "string" ? payload.detail.slice(0, 400) : `HTTP ${response.status}`;
      throw new Error(`legacy reauthentication worker failed: ${detail}`);
    }
    const sso = typeof payload.sso === "string" ? payload.sso.trim() : "";
    if (!sso) throw new Error("legacy reauthentication worker returned no SSO token");
    return sso;
  }
}

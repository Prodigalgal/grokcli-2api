import type { BrowserTaskRunner } from "../automation/browser-task-runner.js";
import type { CloudflareMailboxCredentialStore, SsoRegistrationConverter } from "./cloudflare-registration-runner.js";
import type { RegistrationProxyProvider } from "./sing-box-proxy-manager.js";

interface PythonRegistrationOptions {
  readonly serviceUrl: string;
  readonly token: string | null;
  readonly timeoutMs: number;
  readonly cfMailBaseUrl: string;
  readonly cfMailAdminPassword: string;
  readonly cfMailDomain: string | null;
  readonly proxyProvider: RegistrationProxyProvider;
  readonly ssoConverter: SsoRegistrationConverter;
  readonly mailboxStore: CloudflareMailboxCredentialStore;
  readonly fetchImpl?: typeof fetch;
}

export class PythonRegistrationTaskRunner implements BrowserTaskRunner {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PythonRegistrationOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async run(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const proxy = await this.options.proxyProvider.acquire();
    let sessionId = "";
    let completed = false;
    try {
      const mailbox = record(request.mailbox);
      const started = await this.call("/internal/registration/v1/jobs", {
        captcha_provider: "local",
        local_solver_url: "http://127.0.0.1:5072",
        proxy: proxy.server,
        proxy_strategy: "sticky",
        mail_provider: "cfmail",
        cfmail_base_url: this.options.cfMailBaseUrl,
        cfmail_api_key: this.options.cfMailAdminPassword,
        cfmail_domain: string(mailbox?.domain) || this.options.cfMailDomain || "",
        count: 1,
        concurrency: 1,
        probe_delay_sec: 0,
      }, "POST");
      sessionId = string(started.id || started.session_id);
      if (!sessionId) {
        throw new Error("registration worker did not return a session id");
      }
      const deadline = Date.now() + this.options.timeoutMs;
      while (Date.now() < deadline) {
        const session = await this.call(`/internal/registration/v1/sessions/${encodeURIComponent(sessionId)}?include_auth_json=1`, undefined, "GET");
        const status = string(session.status).toLowerCase();
        if (["completed", "success", "imported"].includes(status)) {
          const external = record(record(session.auth_json)?.external_registration);
          const sso = string(external?.sso);
          const email = string(external?.email);
          const workerMailbox = record(external?.mailbox);
          if (!sso || !email || !workerMailbox) {
            throw new Error("registration worker completed without an external SSO result");
          }
          const account = await this.options.ssoConverter.registerFromSsoCookie(sso, email);
          const mailboxId = string(workerMailbox.id);
          const mailboxAddress = string(workerMailbox.address) || email;
          const mailboxToken = string(workerMailbox.access_token);
          if (mailboxId && mailboxAddress && mailboxToken) {
            this.options.mailboxStore.saveCloudflareMailboxCredential(account.accountId, {
              id: mailboxId,
              address: mailboxAddress,
              accessToken: mailboxToken,
            });
          }
          completed = true;
          return {
            accountId: account.accountId,
            email: account.email ?? email,
            mailProvider: "cloudflare_temp_mail",
            executor: "python_registration_worker",
          };
        }
        if (["error", "failed", "expired", "protocol_error", "protocol_blocked", "cancelled", "stopped"].includes(status)) {
          throw new Error(`registration worker ended with ${status}: ${string(session.error || session.message).slice(0, 300)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw new Error("registration worker timed out");
    } finally {
      if (sessionId && !completed) {
        await this.call(`/internal/registration/v1/sessions/${encodeURIComponent(sessionId)}/stop`, {}, "POST").catch(() => undefined);
      }
      await proxy.release();
    }
  }

  private async call(path: string, body: Record<string, unknown> | undefined, method: "GET" | "POST"): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.options.serviceUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      throw new Error(`registration worker HTTP ${response.status}: ${string(record(payload)?.detail).slice(0, 300)}`);
    }
    const output = record(payload);
    if (!output) {
      throw new Error("registration worker returned invalid JSON");
    }
    return output;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

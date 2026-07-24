import type { BrowserTaskRunner } from "../automation/browser-task-runner.js";
import type { BrowserTaskRuntime } from "../automation/browser-task-runner.js";
import type { CloudflareMailboxCredentialStore, SsoRegistrationConverter } from "./cloudflare-registration-runner.js";

interface PythonRegistrationOptions {
  readonly serviceUrl: string;
  readonly token: string | null;
  readonly timeoutMs: number;
  readonly cfMailBaseUrl: string;
  readonly cfMailAdminPassword: string;
  readonly cfMailDomain: string | null;
  readonly ssoConverter: SsoRegistrationConverter;
  readonly mailboxStore: CloudflareMailboxCredentialStore;
  readonly fetchImpl?: typeof fetch;
}

export class PythonRegistrationTaskRunner implements BrowserTaskRunner {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PythonRegistrationOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async run(request: Record<string, unknown>, runtime: BrowserTaskRuntime = {}): Promise<Record<string, unknown>> {
    const registration = record(request.registration);
    let sessionId = "";
    let completed = false;
    let lastWorkerEvent = "";
    try {
      const mailbox = record(request.mailbox);
      runtime.signal?.throwIfAborted();
      runtime.onEvent?.({ type: "worker_started", message: "注册工作器已启动" });
      const started = await this.call("/internal/registration/v1/jobs", {
        captcha_provider: "local",
        local_solver_url: "http://127.0.0.1:5072",
        proxy: "",
        mail_provider: "cfmail",
        cfmail_base_url: string(registration?.mailBaseUrl) || this.options.cfMailBaseUrl,
        cfmail_api_key: string(registration?.mailApiKey) || this.options.cfMailAdminPassword,
        cfmail_domain: string(registration?.mailDomain) || string(mailbox?.domain) || this.options.cfMailDomain || "",
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
        runtime.signal?.throwIfAborted();
        const session = await this.call(`/internal/registration/v1/sessions/${encodeURIComponent(sessionId)}?include_auth_json=1`, undefined, "GET");
        const status = string(session.status).toLowerCase();
        const workerMessage = string(session.message) || `注册状态：${status || "running"}`;
        const workerEvent = `${status}\n${workerMessage}`;
        if (workerEvent !== lastWorkerEvent) {
          runtime.onEvent?.({ type: `worker_${status || "running"}`, message: workerMessage });
          lastWorkerEvent = workerEvent;
        }
        if (["completed", "success", "imported"].includes(status)) {
          const external = record(record(session.auth_json)?.external_registration);
          const sso = string(external?.sso);
          const email = string(external?.email);
          const token = record(external?.token);
          const workerMailbox = record(external?.mailbox);
          if (!sso || !email || !workerMailbox || !string(token?.access_token)) {
            throw new Error("registration worker completed without protocol authentication");
          }
          const account = await this.options.ssoConverter.registerFromSsoCookie(sso, email, token!);
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
        await abortableDelay(1_000, runtime.signal);
      }
      throw new Error("registration worker timed out");
    } finally {
      if (sessionId && !completed) {
        await this.call(`/internal/registration/v1/sessions/${encodeURIComponent(sessionId)}/stop`, {}, "POST").catch(() => undefined);
      }
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

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("registration cancelled"));
    }, { once: true });
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

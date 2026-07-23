import type { DeviceLoginService } from "../auth/device-login-service.js";
import type { SsoReauthService } from "../auth/sso-reauth-service.js";
import type { AppConfig } from "../config.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type { BrowserTaskRunner } from "./browser-task-runner.js";

export interface AutomationTaskWorkerOptions {
  readonly store: SqliteStore;
  readonly deviceLogins: DeviceLoginService;
  readonly ssoReauth: Pick<SsoReauthService, "reauthenticate">;
  readonly browserRunner: BrowserTaskRunner;
  readonly registrationRunner?: BrowserTaskRunner | null;
  readonly emailLoginRunner?: BrowserTaskRunner | null;
  readonly config: Pick<AppConfig, "workerLeaseMs" | "ssoReauthCooldownMs">;
  readonly owner?: string;
}

export class AutomationTaskWorker {
  private readonly owner: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: AutomationTaskWorkerOptions) {
    this.owner = options.owner?.trim() || `node-${process.pid}`;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.runOnce(), 1_000);
    this.timer.unref();
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      this.reconcileWaitingDeviceLogins();
      const tasks = this.options.store.automationTasks();
      const task = tasks.claimNext(this.owner, this.options.config.workerLeaseMs);
      if (!task) {
        return;
      }
      tasks.markRunning(task.id, this.owner);
      if (task.kind === "sso_reauth") {
        await this.runSsoReauth(task.id, task.request);
        return;
      }
      if (task.kind === "browser_automation" || task.kind === "registration" || task.kind === "sso_email_reauth") {
        try {
          const runner = task.kind === "registration"
            ? this.options.registrationRunner
            : task.kind === "sso_email_reauth"
              ? this.options.emailLoginRunner
              : this.options.browserRunner;
          if (!runner) {
            throw new Error(task.kind === "sso_email_reauth"
              ? "Cloudflare Temp Mail email login is not configured"
              : "Cloudflare Temp Mail registration is not configured");
          }
          const result = await runner.run(task.request);
          tasks.succeed(task.id, this.owner, result);
        } catch (error) {
          tasks.fail(task.id, this.owner, messageFor(error));
        }
        return;
      }
      tasks.fail(task.id, this.owner, `unsupported automation task kind: ${task.kind}`);
    } finally {
      this.running = false;
    }
  }

  private async runSsoReauth(taskId: string, request: Record<string, unknown>): Promise<void> {
    const accountId = typeof request.accountId === "string" ? request.accountId.trim() : "";
    const tasks = this.options.store.automationTasks();
    if (!accountId) {
      tasks.fail(taskId, this.owner, "sso_reauth task is missing accountId");
      return;
    }
    try {
      const result = await this.options.ssoReauth.reauthenticate(accountId);
      tasks.succeed(taskId, this.owner, { accountId: result.accountId, recoveredBy: "sso" });
    } catch (error) {
      const reason = messageFor(error);
      this.options.store.markSsoReauthFailure(accountId, reason, this.options.config.ssoReauthCooldownMs);
      try {
        const session = await this.options.deviceLogins.start(accountId);
        tasks.waitForInput(taskId, this.owner, {
          accountId,
          recovery: "device_login",
          deviceLoginSessionId: session.id,
          userCode: session.userCode,
          verificationUrl: session.verificationUrl,
          expiresAt: session.expiresAt,
        });
      } catch (deviceError) {
        tasks.fail(taskId, this.owner, `SSO recovery failed and device login could not start: ${messageFor(deviceError)}`);
      }
    }
  }

  private reconcileWaitingDeviceLogins(): void {
    const tasks = this.options.store.automationTasks();
    for (const task of tasks.listByStatus("waiting_input", "sso_reauth")) {
      const sessionId = typeof task.result?.deviceLoginSessionId === "string" ? task.result.deviceLoginSessionId : "";
      if (!sessionId) {
        continue;
      }
      const session = this.options.store.getDeviceLoginSession(sessionId);
      if (session?.status === "succeeded") {
        tasks.succeedWaitingForInput(task.id, {
          accountId: session.accountId,
          recoveredBy: "device_login",
          deviceLoginSessionId: session.id,
        });
      }
    }
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 400) : "automation task failed";
}

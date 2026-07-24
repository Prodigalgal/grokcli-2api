import {
  supportsSsoCookieCapture,
  type BrowserTaskRunner,
} from "../automation/browser-task-runner.js";
import type { CloudflareMailboxCredential } from "../storage/sqlite-store.js";
import { CloudflareTempMailClient } from "./cloudflare-temp-mail.js";
import type { RegistrationProxyProvider } from "./sing-box-proxy-manager.js";

export interface EmailLoginAccountStore {
  getAccount(id: string): { readonly id: string; readonly email: string | null; readonly payload?: Record<string, unknown> } | null;
  getCloudflareMailboxCredential(accountId: string): CloudflareMailboxCredential | null;
}

export interface SsoEmailLoginConverter {
  restoreFromSsoCookie(accountId: string, ssoCookie: string): Promise<{ readonly accountId: string; readonly email: string | null }>;
}

export class CloudflareEmailLoginTaskRunner implements BrowserTaskRunner {
  constructor(
    private readonly browser: BrowserTaskRunner,
    private readonly mail: CloudflareTempMailClient,
    private readonly accounts: EmailLoginAccountStore,
    private readonly ssoConverter: SsoEmailLoginConverter,
    private readonly proxyProvider?: RegistrationProxyProvider | null,
  ) {}

  async run(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const accountId = typeof request.accountId === "string" ? request.accountId.trim() : "";
    if (!accountId) {
      throw new Error("email login task is missing accountId");
    }
    const account = this.accounts.getAccount(accountId);
    if (!account) {
      throw new Error("account was not found");
    }
    const mailbox = this.accounts.getCloudflareMailboxCredential(accountId)
      ?? (account.email ? await this.mail.recoverMailbox(account.email) : null);
    if (!mailbox) {
      throw new Error("account email was not found in the configured Cloudflare Temp Mail service");
    }
    if (!supportsSsoCookieCapture(this.browser)) {
      throw new Error("email login browser runner cannot capture the authenticated SSO cookie");
    }
    const proxy = await this.proxyProvider?.acquire();
    try {
      const captured = await this.browser.runWithSsoCookie(request, {
        variables: {
          "account.email": account.email ?? mailbox.address,
          "account.password": accountPassword(account.payload),
          "mailbox.address": mailbox.address,
          "mailbox.email": mailbox.address,
        },
        waitForMailCode: () => this.mail.waitForCode(mailbox),
        ...(proxy ? { proxyServer: proxy.server } : {}),
      });
      const restored = await this.ssoConverter.restoreFromSsoCookie(accountId, captured.ssoCookie);
      return {
        ...captured.result,
        accountId: restored.accountId,
        email: restored.email ?? account.email ?? mailbox.address,
        recoveredBy: "email_code",
      };
    } finally {
      await proxy?.release();
    }
  }
}

function accountPassword(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  for (const key of ["password", "register_password"]) {
    if (typeof payload[key] === "string" && payload[key].trim()) return payload[key].trim();
  }
  return "";
}

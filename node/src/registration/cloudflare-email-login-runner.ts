import {
  supportsSsoCookieCapture,
  type BrowserTaskRunner,
} from "../automation/browser-task-runner.js";
import type { CloudflareMailboxCredential } from "../storage/sqlite-store.js";
import { CloudflareTempMailClient } from "./cloudflare-temp-mail.js";

export interface EmailLoginAccountStore {
  getAccount(id: string): { readonly id: string; readonly email: string | null } | null;
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
  ) {}

  async run(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const accountId = typeof request.accountId === "string" ? request.accountId.trim() : "";
    if (!accountId) {
      throw new Error("email login task is missing accountId");
    }
    const account = this.accounts.getAccount(accountId);
    const mailbox = this.accounts.getCloudflareMailboxCredential(accountId);
    if (!account || !mailbox) {
      throw new Error("account has no stored Cloudflare Temp Mail inbox; start device login instead");
    }
    if (!supportsSsoCookieCapture(this.browser)) {
      throw new Error("email login browser runner cannot capture the authenticated SSO cookie");
    }
    const captured = await this.browser.runWithSsoCookie(request, {
      variables: {
        "account.email": account.email ?? mailbox.address,
        "mailbox.address": mailbox.address,
        "mailbox.email": mailbox.address,
      },
      waitForMailCode: () => this.mail.waitForCode(mailbox),
    });
    const restored = await this.ssoConverter.restoreFromSsoCookie(accountId, captured.ssoCookie);
    return {
      ...captured.result,
      accountId: restored.accountId,
      email: restored.email ?? account.email ?? mailbox.address,
      recoveredBy: "email_code",
    };
  }
}

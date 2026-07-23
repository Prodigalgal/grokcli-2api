import {
  supportsSsoCookieCapture,
  type BrowserTaskRunner,
} from "../automation/browser-task-runner.js";
import { CloudflareTempMailClient } from "./cloudflare-temp-mail.js";
import type { RegistrationProxyProvider } from "./sing-box-proxy-manager.js";

export interface SsoRegistrationConverter {
  registerFromSsoCookie(ssoCookie: string, email?: string | null): Promise<{ readonly accountId: string; readonly email: string | null }>;
}

export interface CloudflareMailboxCredentialStore {
  saveCloudflareMailboxCredential(accountId: string, mailbox: {
    readonly id: string;
    readonly address: string;
    readonly accessToken: string;
  }): unknown;
}

export class CloudflareRegistrationTaskRunner implements BrowserTaskRunner {
  constructor(
    private readonly browser: BrowserTaskRunner,
    private readonly mail: CloudflareTempMailClient,
    private readonly ssoConverter: SsoRegistrationConverter,
    private readonly mailboxStore: CloudflareMailboxCredentialStore,
    private readonly proxyProvider: RegistrationProxyProvider,
  ) {}

  async run(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const proxy = await this.proxyProvider.acquire();
    try {
      const mailboxInput = mailboxInputFrom(request);
      const mailbox = await this.mail.createMailbox(mailboxInput);
      if (!supportsSsoCookieCapture(this.browser)) {
        throw new Error("registration browser runner cannot capture the authenticated SSO cookie");
      }
      const captured = await this.browser.runWithSsoCookie(request, {
        variables: {
          "mailbox.address": mailbox.address,
          "mailbox.email": mailbox.address,
        },
        waitForMailCode: () => this.mail.waitForCode(mailbox),
        proxyServer: proxy.server,
      });
      const account = await this.ssoConverter.registerFromSsoCookie(captured.ssoCookie, mailbox.address);
      this.mailboxStore.saveCloudflareMailboxCredential(account.accountId, mailbox);
      return {
        ...captured.result,
        accountId: account.accountId,
        email: account.email ?? mailbox.address,
        mailProvider: "cloudflare_temp_mail",
      };
    } finally {
      await proxy.release();
    }
  }
}

function mailboxInputFrom(request: Record<string, unknown>): { name?: string; domain?: string } {
  const raw = request.mailbox;
  if (!raw || Array.isArray(raw) || typeof raw !== "object") {
    return {};
  }
  const input = raw as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const domain = typeof input.domain === "string" ? input.domain.trim() : "";
  return {
    ...(name ? { name } : {}),
    ...(domain ? { domain } : {}),
  };
}

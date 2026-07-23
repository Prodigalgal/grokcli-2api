import { randomBytes } from "node:crypto";

export interface CloudflareTempMailConfig {
  readonly baseUrl: string;
  readonly adminPassword: string;
  readonly domain?: string | null;
  readonly fetchImpl?: typeof fetch;
}

export interface CloudflareMailbox {
  readonly id: string;
  readonly address: string;
  readonly accessToken: string;
}

export interface MailMessage {
  readonly id: string | null;
  readonly subject: string;
  readonly from: string;
  readonly text: string;
  readonly html: string;
  readonly codes: readonly string[];
  readonly links: readonly string[];
}

export class CloudflareTempMailClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: CloudflareTempMailConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    if (!config.adminPassword.trim()) {
      throw new Error("Cloudflare Temp Mail admin password is required");
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async listDomains(): Promise<string[]> {
    const response = await this.request("/open_api/settings", { method: "GET", headers: siteHeaders(this.config.adminPassword) });
    if (!response.ok) {
      return [];
    }
    const data = await objectJson(response, "Cloudflare Temp Mail domain settings");
    const body = objectValue(data.data) ?? data;
    const domains: string[] = [];
    for (const field of ["defaultDomains", "default_domains", "domains", "randomSubdomainDomains", "random_subdomain_domains"]) {
      const value = body[field];
      const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
      for (const item of items) {
        const domain = normalizeDomain(typeof item === "string" ? item : stringValue(objectValue(item)?.domain) || stringValue(objectValue(item)?.name));
        if (domain && !domains.includes(domain)) {
          domains.push(domain);
        }
      }
    }
    return domains;
  }

  async createMailbox(input: { readonly name?: string; readonly domain?: string | null } = {}): Promise<CloudflareMailbox> {
    const domain = normalizeDomain(input.domain ?? this.config.domain ?? "") || (await this.listDomains())[0] || "";
    if (!domain) {
      throw new Error("Cloudflare Temp Mail domain is required");
    }
    const name = normalizeLocalPart(input.name ?? randomBytes(5).toString("hex"));
    const payload = { name, domain, enablePrefix: false, enableRandomSubdomain: false };
    let response = await this.request("/admin/new_address", {
      method: "POST",
      headers: { ...adminHeaders(this.config.adminPassword), "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      response = await this.request("/api/new_address", {
        method: "POST",
        headers: { ...siteHeaders(this.config.adminPassword), "content-type": "application/json" },
        body: JSON.stringify({ name, domain, enableRandomSubdomain: false }),
      });
    }
    if (!response.ok) {
      throw new Error(`Cloudflare Temp Mail address creation failed: HTTP ${response.status}`);
    }
    const data = await objectJson(response, "Cloudflare Temp Mail address response");
    const body = objectValue(data.data) ?? data;
    const address = stringValue(body.address) || stringValue(body.email) || stringValue(body.mail);
    const accessToken = stringValue(body.jwt) || stringValue(body.token) || stringValue(body.credential) || stringValue(body.address_jwt);
    if (!address.includes("@") || !accessToken) {
      throw new Error("Cloudflare Temp Mail address response was incomplete");
    }
    return { id: stringValue(body.address_id) || stringValue(body.id) || address, address, accessToken };
  }

  async fetchMessages(mailbox: CloudflareMailbox): Promise<MailMessage[]> {
    const response = await this.request("/api/parsed_mails?limit=20&offset=0", {
      method: "GET",
      headers: { authorization: `Bearer ${mailbox.accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Cloudflare Temp Mail inbox read failed: HTTP ${response.status}`);
    }
    const data = await objectJson(response, "Cloudflare Temp Mail inbox response");
    const body = objectValue(data.data) ?? data;
    const rows = Array.isArray(body) ? body : Array.isArray(body.results) ? body.results : Array.isArray(body.mails) ? body.mails : Array.isArray(body.items) ? body.items : [];
    return rows.filter(isRecord).slice(0, 20).map(normalizeMessage);
  }

  async waitForCode(mailbox: CloudflareMailbox, timeoutMs = 120_000): Promise<string> {
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    while (Date.now() < deadline) {
      const code = (await this.fetchMessages(mailbox)).flatMap((message) => message.codes)[0];
      if (code) {
        return code;
      }
      await delay(2_000);
    }
    throw new Error("Cloudflare Temp Mail verification code timed out");
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  }
}

function normalizeMessage(row: Record<string, unknown>): MailMessage {
  const text = stringValue(row.text) || stringValue(row.content) || stringValue(row.message) || stringValue(row.raw);
  const html = stringValue(row.html);
  const all = `${stringValue(row.subject)}\n${text}\n${html}`;
  return {
    id: stringValue(row.id) || stringValue(row.mail_id) || stringValue(row.message_id) || null,
    subject: stringValue(row.subject),
    from: stringValue(row.from) || stringValue(row.sender),
    text,
    html,
    codes: [...new Set(all.match(/(?<!\d)\d{6,8}(?!\d)/g) ?? [])],
    links: [...new Set(all.match(/https?:\/\/[^\s"'<>)]+/g) ?? [])],
  };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:") {
    throw new Error("Cloudflare Temp Mail base URL must use https");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeDomain(value: string): string {
  return value.trim().replace(/^@/, "").replace(/^\.+|\.+$/g, "").toLowerCase();
}

function normalizeLocalPart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._+-]/g, "");
  return normalized || randomBytes(5).toString("hex");
}

function adminHeaders(password: string): Record<string, string> {
  return { "x-admin-auth": password, "x-custom-auth": password };
}

function siteHeaders(password: string): Record<string, string> {
  return { "x-custom-auth": password };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function objectJson(response: Response, label: string): Promise<Record<string, unknown>> {
  try {
    const value = await response.json() as unknown;
    if (isRecord(value)) {
      return value;
    }
  } catch {
    // Stable error below; no response body is included because it can contain mailbox data.
  }
  throw new Error(`${label} was not valid JSON`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

  async recoverMailbox(address: string): Promise<CloudflareMailbox | null> {
    const normalized = address.trim().toLowerCase();
    if (!normalized.includes("@")) {
      throw new Error("Cloudflare Temp Mail address is invalid");
    }
    const response = await this.request(`/admin/address?query=${encodeURIComponent(normalized)}&limit=20&offset=0`, {
      method: "GET",
      headers: adminHeaders(this.config.adminPassword),
    });
    if (!response.ok) {
      throw new Error(`Cloudflare Temp Mail address lookup failed: HTTP ${response.status}`);
    }
    const data = await unknownJson(response, "Cloudflare Temp Mail address lookup");
    const rows = arrayRows(data);
    const match = rows.find((row) => addressFromRow(row).toLowerCase() === normalized);
    if (!match) {
      return null;
    }
    const id = stringValue(match.id) || stringValue(match.address_id);
    if (!id) {
      throw new Error("Cloudflare Temp Mail address lookup returned no address id");
    }
    const tokenResponse = await this.request(`/admin/show_password/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: adminHeaders(this.config.adminPassword),
    });
    if (!tokenResponse.ok) {
      throw new Error(`Cloudflare Temp Mail inbox credential refresh failed: HTTP ${tokenResponse.status}`);
    }
    const tokenData = await objectJson(tokenResponse, "Cloudflare Temp Mail inbox credential response");
    const tokenBody = objectValue(tokenData.data) ?? tokenData;
    const accessToken = stringValue(tokenBody.jwt) || stringValue(tokenBody.token);
    if (!accessToken) {
      throw new Error("Cloudflare Temp Mail inbox credential response was incomplete");
    }
    return { id, address: addressFromRow(match) || normalized, accessToken };
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
  const value = await unknownJson(response, label);
  if (isRecord(value)) {
    return value;
  }
  throw new Error(`${label} was not valid JSON`);
}

async function unknownJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    // Stable error below; no response body is included because it can contain mailbox data.
  }
  throw new Error(`${label} was not valid JSON`);
}

function arrayRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  const body = objectValue(value.data) ?? value;
  for (const key of ["results", "addresses", "items", "data"]) {
    if (Array.isArray(body[key])) return body[key].filter(isRecord);
  }
  return [];
}

function addressFromRow(row: Record<string, unknown>): string {
  const direct = stringValue(row.address) || stringValue(row.email);
  if (direct) return direct;
  const name = stringValue(row.name);
  const domain = stringValue(row.domain);
  return name && domain ? `${name}@${domain}` : "";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

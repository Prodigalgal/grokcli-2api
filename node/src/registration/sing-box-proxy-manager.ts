import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { once } from "node:events";

export interface RegistrationProxyLease {
  readonly server: string;
  release(): Promise<void>;
}

export interface RegistrationProxyProvider {
  acquire(): Promise<RegistrationProxyLease>;
  close(): Promise<void>;
}

interface VlessNode {
  readonly id: string;
  readonly server: string;
  readonly port: number;
  readonly uuid: string;
  readonly flow: string;
  readonly security: string;
  readonly serverName: string;
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly shortId: string;
  readonly network: string;
  readonly host: string;
  readonly path: string;
  readonly serviceName: string;
}

export interface SingBoxProxyManagerOptions {
  readonly subscriptionUrl: string;
  readonly binaryPath: string;
  readonly workDir: string;
  readonly startupTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class SingBoxRegistrationProxyManager implements RegistrationProxyProvider {
  private cursor = 0;
  private readonly activeNodes = new Set<string>();
  private readonly releases = new Map<string, () => Promise<void>>();
  private readonly fetchImpl: typeof fetch;
  private readonly startupTimeoutMs: number;

  constructor(private readonly options: SingBoxProxyManagerOptions) {
    const url = new URL(options.subscriptionUrl);
    if (url.protocol !== "https:") {
      throw new Error("registration proxy subscription must use https");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    rmSync(options.workDir, { recursive: true, force: true });
    mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
  }

  async acquire(): Promise<RegistrationProxyLease> {
    const nodes = await this.fetchNodes();
    const node = this.selectNode(nodes);
    const leaseId = randomUUID();
    const leaseDir = join(this.options.workDir, leaseId);
    const configPath = join(leaseDir, "config.json");
    const port = await allocatePort();
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, JSON.stringify(buildSingBoxConfig(node, port)), { encoding: "utf8", mode: 0o600 });

    this.activeNodes.add(node.id);
    const child = spawn(this.options.binaryPath, ["run", "-c", configPath], {
      cwd: leaseDir,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr?.resume();

    let released = false;
    const release = async (): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      this.releases.delete(leaseId);
      this.activeNodes.delete(node.id);
      await terminate(child);
      rmSync(leaseDir, { recursive: true, force: true });
    };
    this.releases.set(leaseId, release);
    try {
      await waitForPort(port, child, this.startupTimeoutMs);
    } catch (error) {
      await release();
      throw error;
    }
    return { server: `http://127.0.0.1:${port}`, release };
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.releases.values()].map((release) => release()));
    rmSync(this.options.workDir, { recursive: true, force: true });
  }

  private async fetchNodes(): Promise<VlessNode[]> {
    const response = await this.fetchImpl(this.options.subscriptionUrl, {
      headers: { "user-agent": "grok2api-registration-proxy/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`registration proxy subscription returned HTTP ${response.status}`);
    }
    const body = await response.text();
    if (body.length > 4 * 1024 * 1024) {
      throw new Error("registration proxy subscription is too large");
    }
    const nodes = decodeSubscription(body).map(parseVlessNode).filter((node): node is VlessNode => node !== null);
    if (nodes.length === 0) {
      throw new Error("registration proxy subscription contains no supported VLESS nodes");
    }
    return nodes;
  }

  private selectNode(nodes: readonly VlessNode[]): VlessNode {
    for (let offset = 0; offset < nodes.length; offset += 1) {
      const index = (this.cursor + offset) % nodes.length;
      const node = nodes[index];
      if (node && !this.activeNodes.has(node.id)) {
        this.cursor = (index + 1) % nodes.length;
        return node;
      }
    }
    throw new Error("registration proxy nodes are all leased");
  }
}

export function parseVlessNode(uri: string): VlessNode | null {
  try {
    const url = new URL(uri.trim());
    if (url.protocol !== "vless:" || !url.username || !url.hostname) {
      return null;
    }
    const port = Number(url.port || "443");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return null;
    }
    const value = (name: string): string => url.searchParams.get(name)?.trim() || "";
    return {
      id: createHash("sha256").update(uri.trim()).digest("hex"),
      server: url.hostname,
      port,
      uuid: decodeURIComponent(url.username),
      flow: value("flow"),
      security: value("security").toLowerCase() || "tls",
      serverName: value("sni") || value("host") || url.hostname,
      fingerprint: value("fp") || "chrome",
      publicKey: value("pbk"),
      shortId: value("sid"),
      network: (value("type") || value("network") || "tcp").toLowerCase(),
      host: value("host"),
      path: decodeURIComponent(value("path") || "/"),
      serviceName: value("serviceName") || value("service_name"),
    };
  } catch {
    return null;
  }
}

export function buildSingBoxConfig(node: VlessNode, port: number): Record<string, unknown> {
  const outbound: Record<string, unknown> = {
    type: "vless",
    tag: "registration-node",
    server: node.server,
    server_port: node.port,
    uuid: node.uuid,
    packet_encoding: "xudp",
  };
  if (node.flow) {
    outbound.flow = node.flow;
  }
  if (node.security === "tls" || node.security === "reality") {
    outbound.tls = {
      enabled: true,
      server_name: node.serverName,
      insecure: false,
      utls: { enabled: true, fingerprint: node.fingerprint },
      ...(node.security === "reality" ? {
        reality: { enabled: true, public_key: node.publicKey, short_id: node.shortId },
      } : {}),
    };
  }
  if (node.network === "ws") {
    outbound.transport = { type: "ws", path: node.path, ...(node.host ? { headers: { Host: node.host } } : {}) };
  } else if (node.network === "grpc") {
    outbound.transport = { type: "grpc", service_name: node.serviceName || node.path.replace(/^\//, "") };
  }
  return {
    log: { level: "warn", timestamp: true },
    inbounds: [{ type: "mixed", tag: "registration-in", listen: "127.0.0.1", listen_port: port }],
    outbounds: [outbound],
    route: { final: "registration-node" },
  };
}

function decodeSubscription(value: string): string[] {
  const text = value.trim();
  const decoded = text.includes("vless://") ? text : decodeBase64(text);
  return decoded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function decodeBase64(value: string): string {
  try {
    return Buffer.from(value.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return value;
  }
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) {
    throw new Error("could not allocate a registration proxy port");
  }
  return port;
}

async function waitForPort(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("sing-box exited before the registration proxy became ready");
    }
    if (await canConnect(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("sing-box registration proxy startup timed out");
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const failed = (): void => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", failed);
    socket.once("timeout", failed);
  });
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }
}

import { mkdirSync } from "node:fs";

import { DeviceLoginService } from "./auth/device-login-service.js";
import { SsoReauthService } from "./auth/sso-reauth-service.js";
import { PlaywrightBrowserTaskRunner } from "./automation/browser-task-runner.js";
import { AutomationTaskWorker } from "./automation/task-worker.js";
import { loadConfig } from "./config.js";
import { ChatService } from "./chat/service.js";
import { createApiServer } from "./http/health-server.js";
import { TokenMaintainer } from "./maintainer/service.js";
import { CloudflareRegistrationTaskRunner } from "./registration/cloudflare-registration-runner.js";
import { CloudflareEmailLoginTaskRunner } from "./registration/cloudflare-email-login-runner.js";
import { CloudflareTempMailClient } from "./registration/cloudflare-temp-mail.js";
import { SingleInstanceLock } from "./runtime/single-instance-lock.js";
import { SqliteStore } from "./storage/sqlite-store.js";
import { UsageRecorder } from "./usage/recorder.js";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const lock = SingleInstanceLock.acquire(config.dataDir);
const store = new SqliteStore(config.databasePath);
store.migrate();
const usageRecorder = new UsageRecorder(store, config.usageFlushIntervalMs, config.usageFlushBatch);
const maintainer = new TokenMaintainer({ store, config });
const deviceLogins = new DeviceLoginService({ store, config });
const ssoReauth = new SsoReauthService({ store, deviceLogins, config });
const browserRunner = new PlaywrightBrowserTaskRunner();
const registrationRunner = config.cfMailBaseUrl && config.cfMailAdminPassword
  ? new CloudflareRegistrationTaskRunner(browserRunner, new CloudflareTempMailClient({
    baseUrl: config.cfMailBaseUrl,
    adminPassword: config.cfMailAdminPassword,
    domain: config.cfMailDomain,
  }), ssoReauth, store)
  : null;
const emailLoginRunner = config.cfMailBaseUrl && config.cfMailAdminPassword
  ? new CloudflareEmailLoginTaskRunner(browserRunner, new CloudflareTempMailClient({
    baseUrl: config.cfMailBaseUrl,
    adminPassword: config.cfMailAdminPassword,
    domain: config.cfMailDomain,
  }), store, ssoReauth)
  : null;
const taskWorker = new AutomationTaskWorker({
  store,
  deviceLogins,
  ssoReauth,
  browserRunner,
  registrationRunner,
  emailLoginRunner,
  config,
});
const server = createApiServer({
  modelStore: store,
  apiKeyStore: store,
  defaultModel: config.defaultModel,
  apiKeyAuth: { legacyApiKey: config.legacyApiKey, requireApiKey: config.requireApiKey },
  chatService: new ChatService(store, config.upstreamBase, config.defaultModel, config.poolMode, usageRecorder),
  deviceLogins,
  automationTasks: store.automationTasks(),
  registrationAvailable: registrationRunner !== null,
  adminStore: store,
  adminPassword: config.adminPassword,
});

let stopping = false;
async function stop(exitCode: number): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    maintainer.stop();
    taskWorker.stop();
    usageRecorder.stop();
    await server.close();
  } finally {
    store.close();
    lock.release();
  }
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

await server.listen(config.host, config.port);
if (config.tokenMaintainerEnabled) {
  maintainer.start();
}
deviceLogins.resume();
taskWorker.start();
usageRecorder.start();
console.info(JSON.stringify({ event: "node_runtime_started", host: config.host, port: config.port, store: "sqlite" }));

import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

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
import { SingBoxRegistrationProxyManager } from "./registration/sing-box-proxy-manager.js";
import { PythonRegistrationTaskRunner } from "./registration/python-registration-runner.js";
import { SingleInstanceLock } from "./runtime/single-instance-lock.js";
import { SqliteStore } from "./storage/sqlite-store.js";
import { UsageRecorder } from "./usage/recorder.js";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const lock = SingleInstanceLock.acquire(config.dataDir);
const store = new SqliteStore(config.databasePath);
store.migrate();
const storedDefaultModel = store.getSetting("default_model");
const runtimeDefaultModel = typeof storedDefaultModel === "string" && storedDefaultModel.trim() ? storedDefaultModel.trim() : config.defaultModel;
const storedPoolMode = store.getSetting("account_mode");
const runtimePoolMode = storedPoolMode === "least_used" || storedPoolMode === "random" || storedPoolMode === "round_robin" ? storedPoolMode : config.poolMode;
const usageRecorder = new UsageRecorder(store, config.usageFlushIntervalMs, config.usageFlushBatch);
const maintainer = new TokenMaintainer({ store, config });
const deviceLogins = new DeviceLoginService({ store, config });
const ssoReauth = new SsoReauthService({ store, deviceLogins, config });
const browserRunner = new PlaywrightBrowserTaskRunner();
const registrationProxy = config.registrationProxySubscriptionUrl
  ? new SingBoxRegistrationProxyManager({
    subscriptionUrl: config.registrationProxySubscriptionUrl,
    binaryPath: config.singBoxPath,
    workDir: config.singBoxWorkDir,
    startupTimeoutMs: config.singBoxStartupTimeoutMs,
    tlsInsecure: config.registrationProxyTlsInsecure,
  })
  : null;
const registrationRunner = config.cfMailBaseUrl && config.cfMailAdminPassword && registrationProxy
  ? config.registrationServiceUrl
    ? new PythonRegistrationTaskRunner({
      serviceUrl: config.registrationServiceUrl,
      token: config.registrationServiceToken,
      timeoutMs: config.registrationTimeoutMs,
      cfMailBaseUrl: config.cfMailBaseUrl,
      cfMailAdminPassword: config.cfMailAdminPassword,
      cfMailDomain: config.cfMailDomain,
      proxyProvider: registrationProxy,
      proxyProviderFactory: (subscriptionUrl) => new SingBoxRegistrationProxyManager({
        subscriptionUrl,
        binaryPath: config.singBoxPath,
        workDir: join(config.singBoxWorkDir, `custom-${randomUUID()}`),
        startupTimeoutMs: config.singBoxStartupTimeoutMs,
        tlsInsecure: config.registrationProxyTlsInsecure,
      }),
      ssoConverter: ssoReauth,
      mailboxStore: store,
    })
    : new CloudflareRegistrationTaskRunner(browserRunner, new CloudflareTempMailClient({
    baseUrl: config.cfMailBaseUrl,
    adminPassword: config.cfMailAdminPassword,
    domain: config.cfMailDomain,
  }), ssoReauth, store, registrationProxy)
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
  defaultModel: runtimeDefaultModel,
  apiKeyAuth: { legacyApiKey: config.legacyApiKey, requireApiKey: config.requireApiKey },
  chatService: new ChatService(store, config.upstreamBase, runtimeDefaultModel, runtimePoolMode, usageRecorder),
  deviceLogins,
  automationTasks: store.automationTasks(),
  automationWorker: taskWorker,
  registrationAvailable: config.automationWorkerEnabled && registrationRunner !== null,
  registrationDefaults: {
    mailBaseUrl: config.cfMailBaseUrl,
    mailDomain: config.cfMailDomain,
    proxyConfigured: registrationProxy !== null,
  },
  adminStore: store,
  adminUsername: config.adminUsername,
  adminPassword: config.adminPassword,
  maintainer,
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
    await registrationProxy?.close();
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
if (config.automationWorkerEnabled) {
  deviceLogins.resume();
  taskWorker.start();
}
usageRecorder.start();
console.info(JSON.stringify({
  event: "node_runtime_started",
  host: config.host,
  port: config.port,
  store: "sqlite",
  automationWorker: config.automationWorkerEnabled,
  tokenMaintainer: config.tokenMaintainerEnabled,
}));

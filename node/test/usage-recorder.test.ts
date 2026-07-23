import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteStore } from "../src/storage/sqlite-store.js";
import { UsageRecorder } from "../src/usage/recorder.js";

test("usage recorder batches telemetry and preserves request idempotency", () => {
  const directory = mkdtempSync(join(tmpdir(), "grok2api-usage-test-"));
  const store = new SqliteStore(join(directory, "app.sqlite"));
  store.migrate(1_700_000_000_000);
  try {
    store.createApiKey({
      id: "key-1",
      name: "usage test",
      prefix: "sk-g2a-test",
      keyHash: "0".repeat(64),
    }, 1_700_000_000_000);
    const recorder = new UsageRecorder(store, 60_000, 2);
    recorder.record({
      requestId: "request-1",
      apiKeyId: "key-1",
      accountId: "account-1",
      model: "grok-4.5",
      protocol: "chat_completions",
      success: true,
      promptTokens: 8,
      completionTokens: 3,
      totalTokens: 11,
      cacheReadTokens: 2,
      createdAt: 1_700_000_000_000,
    });
    recorder.record({
      requestId: "request-2",
      model: "grok-4.5",
      protocol: "responses",
      success: false,
      createdAt: 1_700_000_000_100,
    });
    assert.equal(store.usageSummary(1_700_000_000_200).total.requests, 2);
    assert.equal(store.usageSummary(1_700_000_000_200).total.success, 1);
    assert.equal(store.usageSummary(1_700_000_000_200).total.fail, 1);
    assert.equal(store.usageSummary(1_700_000_000_200).total.totalTokens, 11);
    assert.equal(store.usageSummary(1_700_000_000_200).total.cacheReadTokens, 2);
    assert.equal(store.getApiKeySummary("key-1")?.totalTokensTotal, 11);

    recorder.record({
      requestId: "request-1",
      model: "grok-4.5",
      protocol: "chat_completions",
      success: true,
      totalTokens: 999,
      createdAt: 1_700_000_000_300,
    });
    recorder.stop();
    assert.equal(store.usageSummary(1_700_000_000_400).total.requests, 2);
    assert.equal(store.usageSummary(1_700_000_000_400).total.totalTokens, 11);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

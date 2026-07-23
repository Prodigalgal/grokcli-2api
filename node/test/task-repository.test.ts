import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { AutomationTaskRepository } from "../src/automation/task-repository.js";
import { migrations } from "../src/storage/migrations.js";

function createRepository(): { readonly db: DatabaseSync; readonly repo: AutomationTaskRepository; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-task-test-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  for (const migration of migrations) {
    db.exec(migration.sql);
  }
  return { db, repo: new AutomationTaskRepository(db), dir };
}

test("automation tasks are idempotent and recover expired leases", () => {
  const { db, repo, dir } = createRepository();
  try {
    const first = repo.enqueue("sso_reauth", "idempotency-1", { accountId: "a-1" }, 1_000);
    const duplicate = repo.enqueue("sso_reauth", "idempotency-1", { accountId: "a-1" }, 1_001);
    assert.equal(first.id, duplicate.id);

    const leased = repo.claimNext("worker-a", 50, 1_010);
    assert.equal(leased?.status, "leased");
    assert.equal(leased?.attempts, 1);
    const running = repo.markRunning(first.id, "worker-a", 1_020);
    assert.equal(running.status, "running");

    assert.equal(repo.recoverExpired(1_100), 1);
    const reclaimed = repo.claimNext("worker-b", 50, 1_110);
    assert.equal(reclaimed?.id, first.id);
    assert.equal(reclaimed?.attempts, 2);
    const completed = repo.succeed(first.id, "worker-b", { accountId: "a-1", refreshed: true }, 1_120);
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.result, { accountId: "a-1", refreshed: true });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotency rejects a mismatched task payload", () => {
  const { db, repo, dir } = createRepository();
  try {
    repo.enqueue("registration", "same-key", { count: 1 });
    assert.throws(() => repo.enqueue("registration", "same-key", { count: 2 }));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending tasks can be listed and cancelled without racing an active worker", () => {
  const { db, repo, dir } = createRepository();
  try {
    const queued = repo.enqueue("registration", "cancel-queued", { browser: { url: "https://example.test" } }, 1_000);
    const waiting = repo.enqueue("sso_reauth", "cancel-waiting", { accountId: "account-1" }, 1_001);
    const leased = repo.claimNext("worker-a", 10_000, 1_002);
    assert.equal(leased?.id, queued.id);
    assert.equal(repo.list({ status: "queued" }).map((task) => task.id).includes(waiting.id), true);
    const cancelled = repo.cancelPending(waiting.id, 1_003);
    assert.equal(cancelled.status, "cancelled");
    assert.throws(() => repo.cancelPending(queued.id), /cannot be cancelled while leased/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

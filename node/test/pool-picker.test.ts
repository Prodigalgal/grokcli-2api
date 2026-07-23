import assert from "node:assert/strict";
import test from "node:test";

import { candidateChain, isModelBlocked, type PoolCandidate } from "../src/pool/picker.js";

const now = 1_700_000_000_000;
const base: PoolCandidate = {
  id: "account-a",
  token: "token-a",
  email: null,
  userId: null,
  teamId: null,
  expiresAt: null,
  enabled: true,
  disabledForQuota: false,
  cooldownUntil: null,
  blockedModels: {},
  requestCount: 0,
  weight: 1,
};

test("pool picker excludes expired, cooldown, quota-disabled, and model-blocked accounts", () => {
  const chain = candidateChain([
    base,
    { ...base, id: "expired", expiresAt: now - 1 },
    { ...base, id: "cooling", cooldownUntil: now + 1 },
    { ...base, id: "quota", disabledForQuota: true },
    { ...base, id: "blocked", blockedModels: { "grok-4.5": true } },
  ], "grok-4.5", "round_robin", 10, now);
  assert.deepEqual(chain.map((candidate) => candidate.id), ["account-a"]);
});

test("pool picker preserves current weighted and least-used ordering", () => {
  const chain = candidateChain([
    { ...base, id: "heavy", weight: 2, requestCount: 20 },
    { ...base, id: "idle", weight: 1, requestCount: 0 },
    { ...base, id: "used", weight: 1, requestCount: 5 },
  ], "grok-4.5", "round_robin", 3, now);
  assert.deepEqual(chain.map((candidate) => candidate.id), ["heavy", "idle", "used"]);
  const least = candidateChain(chain, "grok-4.5", "least_used", 3, now);
  assert.deepEqual(least.map((candidate) => candidate.id), ["idle", "used", "heavy"]);
});

test("model-block semantics honor a future timestamp and clear expired timestamps", () => {
  assert.equal(isModelBlocked({ "grok-4.5": now + 60_000 }, "grok-4.5", now), true);
  assert.equal(isModelBlocked({ "grok-4.5": now - 60_000 }, "grok-4.5", now), false);
  assert.equal(isModelBlocked({ "grok-4.5": { blocked: false } }, "grok-4.5", now), false);
});

export type PoolMode = "round_robin" | "least_used" | "random";

export interface PoolCandidate {
  readonly id: string;
  readonly token: string;
  readonly email: string | null;
  readonly userId: string | null;
  readonly teamId: string | null;
  readonly expiresAt: number | null;
  readonly enabled: boolean;
  readonly disabledForQuota: boolean;
  readonly cooldownUntil: number | null;
  readonly blockedModels: Record<string, unknown>;
  readonly requestCount: number;
  readonly weight: number;
}

function numericBlockActive(value: number, nowSeconds: number): boolean {
  if (value <= 0) {
    return true;
  }
  const until = value > 1_000_000_000_000 ? value / 1_000 : value;
  return until > 1_577_836_800 ? until > nowSeconds : true;
}

export function isModelBlocked(blockedModels: Record<string, unknown>, model: string, now = Date.now()): boolean {
  const normalized = model.trim();
  if (!normalized) {
    return false;
  }
  const value = blockedModels[normalized] ?? blockedModels[normalized.toLowerCase()];
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return numericBlockActive(value, now / 1_000);
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    return trimmed !== "" && trimmed !== "0" && trimmed !== "false";
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (object.blocked === false) {
      return false;
    }
    if (typeof object.until === "number" && Number.isFinite(object.until)) {
      return numericBlockActive(object.until, now / 1_000);
    }
    return true;
  }
  return true;
}

export function isEligible(candidate: PoolCandidate, model: string, now = Date.now()): boolean {
  return candidate.id.trim() !== ""
    && candidate.token.trim() !== ""
    && candidate.enabled
    && !candidate.disabledForQuota
    && (candidate.expiresAt === null || candidate.expiresAt > now)
    && (candidate.cooldownUntil === null || candidate.cooldownUntil <= now)
    && !isModelBlocked(candidate.blockedModels, model, now);
}

function normalizedMode(mode: string): PoolMode {
  return mode === "least_used" || mode === "random" ? mode : "round_robin";
}

export function candidateChain(
  candidates: readonly PoolCandidate[],
  model: string,
  mode: string,
  maximum = 1,
  now = Date.now(),
): PoolCandidate[] {
  const selected = candidates.filter((candidate) => isEligible(candidate, model, now));
  const selectedMode = normalizedMode(mode);
  selected.sort((left, right) => {
    if (selectedMode !== "least_used" && left.weight !== right.weight) {
      return right.weight - left.weight;
    }
    if ((selectedMode === "least_used" || selectedMode === "round_robin") && left.requestCount !== right.requestCount) {
      return left.requestCount - right.requestCount;
    }
    return left.id.localeCompare(right.id);
  });
  return selected.slice(0, Math.max(0, maximum));
}

export function pickCandidate(candidates: readonly PoolCandidate[], model: string, mode: string, now = Date.now()): PoolCandidate | null {
  return candidateChain(candidates, model, mode, 1, now)[0] ?? null;
}

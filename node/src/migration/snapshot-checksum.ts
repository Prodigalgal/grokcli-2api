import { createHash } from "node:crypto";

export interface SnapshotChecksumAccount {
  readonly id: string;
  readonly email: string | null;
  readonly userId: string | null;
  readonly teamId: string | null;
  readonly payload: Record<string, unknown>;
}

export interface SnapshotChecksumApiKey {
  readonly id: string;
  readonly enabled: boolean;
  readonly keyHash: string;
}

export interface SnapshotChecksumModel {
  readonly id: string;
  readonly hidden: boolean;
}

export interface SnapshotChecksumInput {
  readonly accounts: readonly SnapshotChecksumAccount[];
  readonly apiKeys: readonly SnapshotChecksumApiKey[];
  readonly models: readonly SnapshotChecksumModel[];
}

export interface SnapshotChecksums {
  readonly inventorySha256: string;
  readonly credentialsSha256: string;
}

export function computeSnapshotChecksums(input: SnapshotChecksumInput): SnapshotChecksums {
  const inventory = createHash("sha256");
  const credentials = createHash("sha256");
  for (const account of [...input.accounts].sort((left, right) => left.id.localeCompare(right.id))) {
    inventory.update(`${account.id}\u0000${account.email ?? ""}\u0000${account.userId ?? ""}\u0000${account.teamId ?? ""}\n`);
    credentials.update(`${account.id}\u0000${hash(canonicalJson(account.payload))}\n`);
  }
  for (const key of [...input.apiKeys].sort((left, right) => left.id.localeCompare(right.id))) {
    inventory.update(`key\u0000${key.id}\u0000${key.enabled ? "1" : "0"}\n`);
    credentials.update(`key\u0000${key.id}\u0000${key.keyHash}\n`);
  }
  for (const model of [...input.models].sort((left, right) => left.id.localeCompare(right.id))) {
    inventory.update(`model\u0000${model.id}\u0000${model.hidden ? "1" : "0"}\n`);
  }
  return {
    inventorySha256: inventory.digest("hex"),
    credentialsSha256: credentials.digest("hex"),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("snapshot contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    throw new Error("snapshot JSON value must be serializable");
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

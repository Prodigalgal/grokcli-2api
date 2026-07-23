import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface IssuedApiKey {
  readonly id: string;
  readonly secret: string;
  readonly prefix: string;
  readonly keyHash: string;
}

export function issueApiKey(): IssuedApiKey {
  const secret = `sk-g2a-${randomBytes(30).toString("base64url")}`;
  return {
    id: randomUUID(),
    secret,
    prefix: secret.slice(0, 14),
    keyHash: createHash("sha256").update(secret).digest("hex"),
  };
}

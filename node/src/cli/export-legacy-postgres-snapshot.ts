import { Pool } from "pg";

import { exportLegacyPostgresSnapshot, writePrivateSnapshot } from "../migration/legacy-postgres-export.js";

const outputPath = process.argv[2]?.trim();
const databaseUrl = process.env.GROK2API_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!outputPath || !databaseUrl) {
  throw new Error("usage: GROK2API_DATABASE_URL=... node build/src/cli/export-legacy-postgres-snapshot.js <output-snapshot.json>");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const exported = await exportLegacyPostgresSnapshot(pool);
  writePrivateSnapshot(outputPath, exported.snapshot);
  console.info(JSON.stringify({ event: "legacy_postgres_snapshot_exported", output: outputPath, ...exported.report }));
} finally {
  await pool.end();
}

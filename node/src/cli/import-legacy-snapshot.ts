import { dirname, resolve } from "node:path";

import { importLegacySnapshot, loadLegacySnapshot } from "../migration/legacy-snapshot-import.js";
import { SingleInstanceLock } from "../runtime/single-instance-lock.js";
import { SqliteStore } from "../storage/sqlite-store.js";

const inputPath = process.argv[2]?.trim();
if (!inputPath) {
  throw new Error("usage: node build/src/cli/import-legacy-snapshot.js <path-to-snapshot.json>");
}

const databasePath = resolve(process.env.GROK2API_SQLITE_PATH?.trim() || "./data-node/app.sqlite");
const dataDir = resolve(process.env.GROK2API_DATA_DIR?.trim() || dirname(databasePath));
const lock = SingleInstanceLock.acquire(dataDir);
const store = new SqliteStore(databasePath);
try {
  store.migrate();
  const report = importLegacySnapshot(store, loadLegacySnapshot(inputPath));
  console.info(JSON.stringify({ event: "legacy_snapshot_imported", ...report }));
} finally {
  store.close();
  lock.release();
}

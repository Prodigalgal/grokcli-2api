import { loadConfig } from "../config.js";
import { importLegacySnapshot, loadLegacySnapshot } from "../migration/legacy-snapshot-import.js";
import { SingleInstanceLock } from "../runtime/single-instance-lock.js";
import { SqliteStore } from "../storage/sqlite-store.js";

const inputPath = process.argv[2]?.trim();
if (!inputPath) {
  throw new Error("usage: node build/src/cli/import-legacy-snapshot.js <path-to-snapshot.json>");
}

const config = loadConfig();
const lock = SingleInstanceLock.acquire(config.dataDir);
const store = new SqliteStore(config.databasePath);
try {
  store.migrate();
  const report = importLegacySnapshot(store, loadLegacySnapshot(inputPath));
  console.info(JSON.stringify({ event: "legacy_snapshot_imported", ...report }));
} finally {
  store.close();
  lock.release();
}

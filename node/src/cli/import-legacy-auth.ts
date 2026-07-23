import { loadConfig } from "../config.js";
import { importLegacyAuthExport, loadLegacyAuthExport } from "../migration/legacy-auth-import.js";
import { SingleInstanceLock } from "../runtime/single-instance-lock.js";
import { SqliteStore } from "../storage/sqlite-store.js";

const inputPath = process.argv[2]?.trim();
if (!inputPath) {
  throw new Error("usage: npm run import:legacy-auth -- <path-to-auth-export.json>");
}

const config = loadConfig();
const lock = SingleInstanceLock.acquire(config.dataDir);
const store = new SqliteStore(config.databasePath);
try {
  store.migrate();
  const report = importLegacyAuthExport(store, loadLegacyAuthExport(inputPath));
  console.info(JSON.stringify({ event: "legacy_auth_imported", ...report }));
} finally {
  store.close();
  lock.release();
}

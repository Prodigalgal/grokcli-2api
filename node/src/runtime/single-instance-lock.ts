import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface LockOwner {
  readonly pid: number;
  readonly createdAt: number;
}

function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export class SingleInstanceLock {
  private released = false;

  private constructor(private readonly path: string, private readonly owner: LockOwner) {}

  static acquire(dataDir: string): SingleInstanceLock {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "grok2api.lock");
    const owner: LockOwner = { pid: process.pid, createdAt: Date.now() };
    try {
      const descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(owner), "utf8");
      return new SingleInstanceLock(path, owner);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
    }
    let previous: LockOwner | null = null;
    try {
      previous = JSON.parse(readFileSync(path, "utf8")) as LockOwner;
    } catch {
      // Corrupt lock files have no trustworthy owner and are replaced below.
    }
    if (previous && isRunning(previous.pid)) {
      throw new Error(`another grok2api Node instance is active (pid ${previous.pid})`);
    }
    rmSync(path, { force: true });
    return SingleInstanceLock.acquire(dataDir);
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    try {
      const actual = JSON.parse(readFileSync(this.path, "utf8")) as LockOwner;
      if (actual.pid === this.owner.pid && actual.createdAt === this.owner.createdAt) {
        rmSync(this.path, { force: true });
      }
    } catch {
      // A missing/replaced lock is already safe to leave alone.
    }
  }
}

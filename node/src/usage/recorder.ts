import type { UsageEventInput } from "../storage/sqlite-store.js";

export interface UsageStore {
  recordUsageBatch(events: readonly UsageEventInput[]): number;
}

export class UsageRecorder {
  private readonly pending: UsageEventInput[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: UsageStore,
    private readonly intervalMs: number,
    private readonly maximumBatch: number,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.flush(), this.intervalMs);
    this.timer.unref();
  }

  record(event: UsageEventInput): void {
    this.pending.push(event);
    if (this.pending.length >= this.maximumBatch) {
      this.flush();
    }
  }

  flush(): number {
    let recorded = 0;
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.maximumBatch);
      recorded += this.store.recordUsageBatch(batch);
    }
    return recorded;
  }

  stop(): number {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.flush();
  }
}

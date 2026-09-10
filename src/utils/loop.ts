// ─── Loop detector — slim port from sabana-dev agents/core/loop-detector.ts ───
export class LoopDetector {
  private calls: Array<{ name: string; hash: string; t: number }> = [];
  private errors: string[] = [];
  constructor(
    private windowSize = 12,
    private maxErrorRepeats = 3,
  ) {}

  record(name: string, args: Record<string, unknown>): { detected: boolean; reason?: string } {
    const hash = JSON.stringify(args);
    this.calls.push({ name, hash, t: Date.now() });
    if (this.calls.length > this.windowSize) this.calls = this.calls.slice(-this.windowSize);

    const rapid = this.calls.filter((c) => c.name === name && c.hash === hash && Date.now() - c.t < 3000);
    if (rapid.length >= 3) {
      return { detected: true, reason: `Tool "${name}" called ${rapid.length}x in a row with identical args` };
    }
    if (this.calls.length >= this.windowSize) {
      const last = this.calls.slice(-this.windowSize);
      const progress = new Set(["write_file", "modified_file", "delete_file", "shell"]);
      if (!last.some((c) => progress.has(c.name))) {
        return {
          detected: true,
          reason: `No write/shell in the last ${this.windowSize} calls. You MUST call write_file / modified_file NOW.`,
        };
      }
    }
    return { detected: false };
  }

  recordError(e: string): { detected: boolean; reason?: string } {
    this.errors.push(e.toLowerCase().replace(/\d+/g, "N").slice(0, 100));
    if (this.errors.length > this.windowSize) this.errors = this.errors.slice(-this.windowSize);
    const same = this.errors.filter((x) => x === this.errors[this.errors.length - 1]);
    if (same.length >= this.maxErrorRepeats) {
      return { detected: true, reason: `Error sama berulang ${same.length}x: ${e.slice(0, 120)}. Ganti pendekatan.` };
    }
    return { detected: false };
  }

  resetProgress(): void {
    this.calls = [];
  }
}

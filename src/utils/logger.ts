// While the fullscreen TUI is active, direct stderr writes collide with the Ink render
// (old text never clears → the display piles up). Enable quiet before rendering.
let quiet = false;

export function setQuiet(v: boolean): void {
  quiet = v;
}

export function isQuiet(): boolean {
  return quiet;
}

export function log(msg: string): void {
  if (quiet) return;
  process.stderr.write(`\x1b[36m[sabana-code]\x1b[0m ${msg}\n`);
}
export function ok(msg: string): void {
  if (quiet) return;
  process.stderr.write(`\x1b[32m✓ ${msg}\x1b[0m\n`);
}
export function warn(msg: string): void {
  if (quiet) return;
  process.stderr.write(`\x1b[33m⚠ ${msg}\x1b[0m\n`);
}
export function err(msg: string): void {
  if (quiet) return;
  process.stderr.write(`\x1b[31m✗ ${msg}\x1b[0m\n`);
}
export function dim(msg: string): void {
  if (quiet) return;
  process.stderr.write(`\x1b[90m${msg}\x1b[0m\n`);
}

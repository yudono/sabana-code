#!/usr/bin/env node
// Dev entry TUI: npm run tui -- [args...]
import { launchTui, parseTuiArgs } from "./launch.js";

async function main(): Promise<void> {
  await launchTui(parseTuiArgs(process.argv.slice(2)));
}

main().catch((e) => {
  process.stderr.write(`\x1b[31mFatal: ${(e as Error).message}\x1b[0m\n`);
  process.exit(1);
});

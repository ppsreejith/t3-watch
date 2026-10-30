#!/usr/bin/env node
import { main } from "../dist/src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`t3-watch: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

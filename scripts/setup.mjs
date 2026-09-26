#!/usr/bin/env node
/**
 * npm run setup [-- --update] [-- --rebuild]
 *
 * Clone (or find) Ranger and Erazer, link the harness into Ranger, and build
 * the tools a session needs. `npm start` runs this first, so it is only worth
 * calling by hand to update the dependencies or force a rebuild.
 */
import { buildTools, ensureDeps, log } from "./lib.mjs";

try {
  const { ranger, erazer } = ensureDeps();
  buildTools(ranger, { force: process.argv.includes("--rebuild") });
  log(`ready  Ranger ${ranger}`);
  log(`       Erazer ${erazer}`);
} catch (e) {
  log(`setup failed: ${e.message}`);
  process.exit(1);
}

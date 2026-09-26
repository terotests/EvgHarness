#!/usr/bin/env node
/**
 * npm run check [-- --web]
 *
 * Every check the harness has, against the linked Ranger checkout. None of
 * them needs an API key: the agents are the recipe, a mock CLI, and a
 * loopback server playing Gemini. `--web` adds the two that drive Chromium.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { buildTools, ensureDeps, liveDir, log } from "./lib.mjs";

let ranger;
try {
  ({ ranger } = ensureDeps());
  buildTools(ranger);
} catch (e) {
  log(`setup failed: ${e.message}`);
  process.exit(1);
}

const env = { ...process.env, RANGER_ROOT: ranger };
const node = (file) => [process.execPath, [path.join(liveDir, file)]];
const checks = [
  ["recipes", "bash", ["scripts/rgr-suite.sh", "./gallery/evg/livebuild/EvgLiveBuildTest.rgr", "./gallery/evg/bin", "EvgLiveBuildTest.js"], /ALL PASS/],
  ["agents", ...node("agents-check.mjs")],
  ["gemini", ...node("gemini-check.mjs")],
  ["stream", ...node("stream-check.mjs")],
  ["app", ...node("app-check.mjs")],
  ["code app", ...node("app-code-check.mjs")],
  ["export", ...node("export-check.mjs")],
  ["save", ...node("save-check.mjs")],
];
// The browser checks drive a running page: start one on a spare port, and
// find a Chromium (CHROME_PATH, or the one Playwright installed).
let server = null;
if (process.argv.includes("--web")) {
  if (!env.CHROME_PATH) {
    try {
      const exe = createRequire(import.meta.url)("playwright-core").chromium.executablePath();
      if (fs.existsSync(exe)) env.CHROME_PATH = exe;
    } catch {
      /* the checks say what is missing */
    }
  }
  const port = 8900 + Math.floor(Math.random() * 90);
  env.EVG_LIVEBUILD_PORT = String(port);
  env.EVG_LIVEBUILD_URL = `http://127.0.0.1:${port}/`;
  server = spawn(process.execPath, [path.join(liveDir, "serve.mjs")], { cwd: ranger, env, stdio: "ignore" });
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${env.EVG_LIVEBUILD_URL}agents`);
      if (r.ok) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  checks.push(["browser", ...node("browser-smoke.mjs")], ["effects", ...node("fx-check.mjs")]);
}

let failed = 0;
for (const [name, cmd, args, mustSay] of checks) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: ranger, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 900000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const ok = r.status === 0 && (!mustSay || mustSay.test(out));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(`${ok ? "pass" : "FAIL"}  ${name.padEnd(9)} ${secs}s`);
  if (!ok) {
    failed += 1;
    log(out.split("\n").slice(-25).map((l) => `      ${l}`).join("\n"));
  }
}
if (server) server.kill();
log(failed ? `${failed} check(s) failed` : "ALL PASS");
process.exit(failed ? 1 : 0);

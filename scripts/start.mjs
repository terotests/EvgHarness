#!/usr/bin/env node
/**
 * npm start [-- --agent=gemini|cursor|claude|codex|recipe] [-- --port=8765]
 *
 * Sets up the dependencies, picks an agent, and serves the live-build page.
 * Without --agent the first available one wins: Gemini (GEMINI_API_KEY or
 * GOOGLE_API_KEY), then the Cursor Agent CLI, then Claude Code, then the
 * scripted recipe that needs no model at all.
 */
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ownsClone, warnMissing, buildTools, detectAgents, ensureDeps, liveDir, log, pickAgent } from "./lib.mjs";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};

let ranger;
try {
  ({ ranger } = ensureDeps());
  buildTools(ranger, { force: process.argv.includes("--rebuild") || process.argv.includes("--update") });
  // The harness's own clone is updated rather than only warned about: a
  // stale .deps/Ranger was the whole reason a real run's titles were
  // invisible. A checkout somebody pointed us at is theirs to update.
  if ((await warnMissing(ranger)) && ownsClone(ranger) && !process.env.EVG_HARNESS_UPDATED) {
    log("update .deps/Ranger now, then start again");
    const up = spawnSync(process.execPath, [path.join(liveDir, "..", "scripts", "setup.mjs"), "--update"], { stdio: "inherit" });
    if (up.status === 0) {
      const again = spawnSync(process.execPath, process.argv.slice(1), {
        stdio: "inherit",
        env: { ...process.env, EVG_HARNESS_UPDATED: "1" },
      });
      process.exit(again.status ?? 1);
    }
  }
} catch (e) {
  log(`setup failed: ${e.message}`);
  process.exit(1);
}

const found = detectAgents();
// The orchestrator's own test for a Cursor CLI that can actually run.
process.env.RANGER_ROOT = ranger;
const { cursorLoggedIn, findCursorAgent } = await import("../livebuild/agents.mjs");
found.cursor = findCursorAgent();
const cursorReady = Boolean(found.cursor) && cursorLoggedIn(found.cursor);
const agent = pickAgent(arg("agent") || process.env.EVG_LIVEBUILD_DEFAULT_AGENT || "", { ...found, cursor: cursorReady });
const port = Number(arg("port") || process.env.EVG_LIVEBUILD_PORT || 8765);

const mark = (ok) => (ok ? "yes" : "no ");
log("");
log(`  gemini     ${mark(found.gemini)}  ${found.gemini ? `model ${process.env.EVG_GEMINI_MODEL || "gemini-3.8-flash"}` : "set GEMINI_API_KEY (https://aistudio.google.com/apikey)"}`);
log(`  cursor     ${mark(cursorReady)}  ${found.cursor ? `${found.cursor}${cursorReady ? "" : " — not logged in: agent login, or CURSOR_API_KEY"}` : "curl https://cursor.com/install -fsS | bash && agent login"}`);
log(`  claude     ${mark(found.claude)}  ${found.claude || "npm i -g @anthropic-ai/claude-code"}`);
log(`  tesseract  ${mark(found.tesseract)}  ${found.tesseract ? "OCR for attached screenshots" : "optional: words from an attached screenshot"}`);
if (agent === "claude" && typeof process.getuid === "function" && process.getuid() === 0 && !process.env.IS_SANDBOX) {
  log("  note       Claude Code refuses --dangerously-skip-permissions as root; run as a normal user (or IS_SANDBOX=1 in a sandbox)");
}
log("");
log(`  agent      ${agent}`);
log(`  open       http://127.0.0.1:${port}/?agent=${agent}`);
log("");

const child = spawn(process.execPath, [path.join(liveDir, "serve.mjs")], {
  cwd: ranger,
  env: {
    ...process.env,
    RANGER_ROOT: ranger,
    EVG_LIVEBUILD_DEFAULT_AGENT: agent,
    EVG_LIVEBUILD_PORT: String(port),
  },
  stdio: "inherit",
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));

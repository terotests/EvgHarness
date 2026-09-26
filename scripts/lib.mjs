/**
 * Shared by `npm run setup` and `npm start`.
 *
 * The harness needs two other repositories:
 *
 *   Ranger  the compiler (dist/rgrc.js), lib/evg, gallery/ui — the engine
 *   Erazer  screenshot → EVG widget tree, for a picture attached to the ask
 *
 * Both are cloned into .deps/ unless RANGER_DIR / ERAZER_DIR point at an
 * existing checkout. The harness and Erazer are then LINKED into the Ranger
 * checkout (gallery/evg/livebuild, gallery/erazer), because their Ranger
 * sources import `pkg:evg` relative to that place and are compiled by
 * Ranger's own compiler.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const liveDir = path.join(harnessRoot, "livebuild");
export const depsDir = path.join(harnessRoot, ".deps");

const config = JSON.parse(fs.readFileSync(path.join(harnessRoot, "harness.config.json"), "utf8"));

export function log(line) {
  process.stderr.write(`${line}\n`);
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${(r.stderr || r.stdout || "").trim()}`);
  }
  return (r.stdout || "").trim();
}

function isOurs(dir) {
  return path.resolve(dir).startsWith(depsDir + path.sep);
}

// A checkout the harness owns is cloned on first use and, with --update,
// pulled. A checkout somebody pointed us at is never touched beyond the two
// links, and not at all if one of the link paths is a real directory.
function ensureRepo({ name, envVar, url, ref }) {
  const given = process.env[envVar];
  const dir = given ? path.resolve(given) : path.join(depsDir, name);
  const wantRef = process.env[`${envVar.replace(/_DIR$/, "")}_REF`] || ref;
  if (!fs.existsSync(path.join(dir, ".git")) && !fs.existsSync(dir)) {
    if (given) throw new Error(`${envVar}=${given} does not exist`);
    fs.mkdirSync(depsDir, { recursive: true });
    log(`clone  ${url} (${wantRef || "default branch"}) → ${path.relative(harnessRoot, dir)}`);
    git(["clone", "--depth", "1", ...(wantRef ? ["--branch", wantRef] : []), url, dir], harnessRoot);
  } else if (process.argv.includes("--update") && isOurs(dir)) {
    log(`update ${name} (${wantRef || "default branch"})`);
    git(["fetch", "--depth", "1", "origin", wantRef || "HEAD"], dir);
    // The clone is the harness's own, and an older one tracks files the
    // link replaced (gallery/evg/livebuild), which a plain checkout refuses
    // to overwrite. Nothing in it is anybody's work, so take the fetched
    // tree as it is; the links are put back right after.
    git(["checkout", "-q", "-f", "--detach", "FETCH_HEAD"], dir);
  }
  return dir;
}

function link(target, at, owner) {
  const rel = path.relative(owner, at);
  let st = null;
  try {
    st = fs.lstatSync(at);
  } catch {
    st = null;
  }
  if (st && st.isSymbolicLink()) {
    if (path.resolve(path.dirname(at), fs.readlinkSync(at)) === path.resolve(target)) return;
    fs.unlinkSync(at);
  } else if (st) {
    if (!isOurs(owner)) {
      throw new Error(
        `${at} is a real directory in your Ranger checkout.\n` +
          `The harness needs to link ${target} there. Move or delete that directory ` +
          `(it is what EvgHarness replaced), or leave RANGER_DIR unset to use .deps/Ranger.`,
      );
    }
    fs.rmSync(at, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
  log(`link   ${rel} → ${target}`);
}

export function ensureDeps() {
  const ranger = ensureRepo({ name: "Ranger", envVar: "RANGER_DIR", url: config.ranger.url, ref: config.ranger.ref });
  const erazer = ensureRepo({ name: "Erazer", envVar: "ERAZER_DIR", url: config.erazer.url, ref: config.erazer.ref });
  if (!fs.existsSync(path.join(ranger, "dist", "rgrc.js"))) {
    throw new Error(`${ranger} is not a Ranger checkout (no dist/rgrc.js)`);
  }
  link(liveDir, path.join(ranger, "gallery", "evg", "livebuild"), ranger);
  link(erazer, path.join(ranger, "gallery", "erazer"), ranger);
  return { ranger, erazer };
}

// --- builds ------------------------------------------------------------------
//
// Every tool is compiled from Ranger into a bin/ that git ignores, so a fresh
// clone has the sources and not the tools. Build the ones a session needs up
// front; the slow bitmap tracer is still built the first time a picture is
// attached.
const TOOLS = [
  { src: "gallery/evg/livebuild/EvgLiveBuildMain.rgr", out: "gallery/evg/bin/evg_livebuild.js", flag: "-nodecli", watch: liveDir },
  { src: "lib/evg/agent/evg_agent.rgr", out: "lib/evg/bin/evg_agent.js", flag: "-nodecli" },
  { src: "gallery/evg/livebuild/EvgAppTool.rgr", out: "gallery/evg/bin/evg_app.js", flag: "-nodecli", watch: liveDir },
  { src: "gallery/ui/src/UiHost.rgr", out: "gallery/ui/bin/ui_host.cjs", flag: "-nodemodule" },
  { src: "gallery/erazer/erazer_cli.rgr", out: "gallery/erazer/bin/erazer_cli.js", flag: "-nodecli", optional: true },
];

function newestRgr(dir) {
  let t = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".rgr")) t = Math.max(t, fs.statSync(path.join(dir, name)).mtimeMs);
  }
  return t;
}

function compile(ranger, tool) {
  const out = path.join(ranger, tool.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  const r = spawnSync(
    process.execPath,
    ["dist/rgrc.js", "-es6", tool.flag, `./${tool.src}`, `-d=./${path.dirname(tool.out)}`, `-o=${path.basename(tool.out)}`],
    {
      cwd: ranger,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, RANGER_LIB: "./compiler/Lang.rgr:./lib/stdops.rgr" },
    },
  );
  const text = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status !== 0 || /Compilation FAILED/.test(text) || !fs.existsSync(out)) {
    const fail = text.split("\n").filter((l) => /\[FAIL\]|FAILED|error/i.test(l)).slice(0, 30);
    throw new Error(`compile ${tool.src} failed:\n${fail.join("\n") || text.slice(-1500)}`);
  }
}

// A Ranger older than the harness: say what is missing and how to get it.
export async function warnMissing(ranger) {
  process.env.RANGER_ROOT = ranger;
  const { capabilities } = await import("../livebuild/capabilities.mjs");
  const caps = capabilities();
  const want = ["tabbar", "tiles", "bars", "banner", "pills"].filter((p) => !caps.pieces.includes(p));
  const lines = [];
  if (want.length) lines.push(`the UI kit has no ${want.join(", ")}`);
  if (!caps.theme) lines.push("a document's theme is ignored (kit pieces stay light on a dark screen)");
  if (!lines.length) return false;
  log(`note   this Ranger checkout is older than the harness: ${lines.join("; ")}.`);
  log(`       ${ranger.startsWith(depsDir) ? "npm run setup -- --update" : "update your Ranger checkout (git pull)"} fixes it. Agents are told what is missing meanwhile.`);
  return true;
}

export const ownsClone = (dir) => isOurs(dir);

export function buildTools(ranger, { force = false } = {}) {
  for (const tool of TOOLS) {
    const out = path.join(ranger, tool.out);
    const stale =
      force ||
      !fs.existsSync(out) ||
      (tool.watch && newestRgr(tool.watch) > fs.statSync(out).mtimeMs);
    if (!stale) continue;
    const t0 = Date.now();
    try {
      compile(ranger, tool);
      log(`build  ${tool.out} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      if (!tool.optional) throw e;
      log(`skip   ${tool.out}: ${String(e.message).split("\n")[0]}`);
    }
  }
}

// --- which agent -------------------------------------------------------------

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").split(/\r?\n/)[0].trim() : "";
}

export function detectAgents() {
  const gemini = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  const cursor = process.env.CURSOR_AGENT_PATH || which("cursor-agent") || which("agent");
  const claude = which("claude");
  const tesseract = process.env.TESSERACT_PATH || which("tesseract");
  return { gemini, cursor, claude, tesseract };
}

// Explicit choice first; otherwise the first one this machine can run.
export function pickAgent(requested, found) {
  if (requested) return requested;
  if (found.gemini) return "gemini";
  if (found.cursor) return "cursor";
  if (found.claude) return "claude";
  return "recipe";
}

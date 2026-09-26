/**
 * What the linked Ranger checkout can actually do.
 *
 * The harness runs against whatever Ranger it is given, and the kit and the
 * engine move. A guide that promises `add_piece tiles` to a kit without
 * tiles, or `theme: dark` to an engine that ignores it, sends the agent
 * exploring — a real Gemini run spent seven turns on kit_spec, then set a
 * dark theme that never applied and left dark titles on a dark page. So the
 * guide is written from what is there, not from what should be.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root } from "./paths.mjs";

let cached = null;

// The PIECES block of `ui_kit list`: "    tiles          A 2×2 of …".
export function parsePieces(listText) {
  const out = [];
  let inPieces = false;
  for (const line of String(listText || "").split("\n")) {
    if (/^PIECES\b/.test(line)) {
      inPieces = true;
      continue;
    }
    if (inPieces && /^\S/.test(line)) break;
    const m = inPieces && /^ {4}([a-z][\w-]*)\s{2,}/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function kitPieces() {
  const tool = path.join(root, "gallery/ui/kit/ui_kit.mjs");
  if (!fs.existsSync(tool)) return [];
  const r = spawnSync(process.execPath, [tool, "list"], { encoding: "utf8", timeout: 30000 });
  return parsePieces(r.stdout);
}

// Lay out a two-node document with a theme-scoped rule and look for its colour.
function themeWorks() {
  const bin = path.join(root, "gallery/evg/bin/evg_livebuild.js");
  if (!fs.existsSync(bin)) return false;
  const file = path.join(os.tmpdir(), `evg-theme-probe-${process.pid}.evg.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      evg: 1,
      css: ".x { background-color: #ff0000; height: 10px }\n.theme-dark .x { background-color: #00ff00 }",
      root: { tag: "div", props: { width: "20px", height: "20px", theme: "dark" }, children: [{ tag: "div", props: { "class-name": "x" } }] },
    }),
  );
  const r = spawnSync(process.execPath, [bin, "frame", file], { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  fs.rmSync(file, { force: true });
  return /0,255,0/.test(r.stdout || "");
}

export function capabilities() {
  if (!cached) cached = { pieces: kitPieces(), theme: themeWorks() };
  return cached;
}

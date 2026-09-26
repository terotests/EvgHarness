/**
 * A screenshot attached to the ask, read as a UI.
 *
 * The bitmap tracer (`evg_image_tool`) answers "what colours, and what shapes"
 * — right for pasting a picture, wrong for rebuilding one: a model handed a
 * palette and a pile of paths has to guess where the cards are. Erazer
 * (https://github.com/terotests/Erazer, linked at gallery/erazer) answers the
 * question an agent actually has: which widgets are here, how they nest,
 * their size, fill, radius, font size and — with Tesseract's words — what
 * they say.
 *
 * Every agent gets the result the same way: `attachment.erazer.txt` beside
 * the document, and a section in AGENTS.md that says what it is. Gemini also
 * gets it in its first message.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root } from "./paths.mjs";

export const ERAZER_TXT = "attachment.erazer.txt";
export const ERAZER_JSON = "attachment.erazer.evg.json";
export const WORDS_TSV = "attachment.words.tsv";

export function erazerBin() {
  return process.env.EVG_ERAZER || path.join(root, "gallery/erazer/bin/erazer_cli.js");
}

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").split(/\r?\n/)[0].trim() : "";
}

export function tesseractBin() {
  return process.env.TESSERACT_PATH || which("tesseract");
}

// Words first: Erazer's own reader only knows a 5×7 test face, so on a real
// screenshot the labels come from Tesseract or not at all.
function readWords(dir, file) {
  const bin = tesseractBin();
  if (!bin) return "";
  const base = path.join(dir, WORDS_TSV.replace(/\.tsv$/, ""));
  const r = spawnSync(bin, [path.join(dir, file), base, "tsv"], { encoding: "utf8", timeout: 60000 });
  return r.status === 0 && fs.existsSync(`${base}.tsv`) ? WORDS_TSV : "";
}

// The outline, minus what an agent cannot use: specks under 6px, and text
// boxes nothing could read. Coordinates stay in the screenshot's pixels; the
// header says how that maps onto the screen being designed.
export function cleanOutline(text, cap = 140) {
  const keep = [];
  for (const line of String(text || "").split("\n")) {
    const m = /^(\s*)(\w+) (-?\d+),(-?\d+) (\d+)x(\d+)(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, role, , , w, h, rest] = m;
    if (Number(w) < 6 || Number(h) < 6) continue;
    if ((role === "text" || role === "label" || role === "shape") && !/"/.test(rest)) continue;
    keep.push(line.replace(/\s+$/, ""));
    if (keep.length >= cap) break;
  }
  return keep.join("\n");
}

/**
 * Run Erazer on `file` in `dir`. Writes attachment.erazer.txt (the outline)
 * and attachment.erazer.evg.json (its absolute-positioned reconstruction).
 * Returns a summary, or null when Erazer is not built — the picture still
 * works as a palette and a trace without it.
 */
export function readScreenshot(dir, file, { width = 390 } = {}) {
  const bin = erazerBin();
  if (!fs.existsSync(bin)) return null;
  const words = readWords(dir, file);
  const args = [bin, file, ERAZER_JSON, "--outline"];
  if (words) args.push("--words", words);
  const r = spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  const out = String(r.stdout || "");
  const size = /(\d+)x(\d+)\s*$/m.exec(out.split("\n").find((l) => /\.evg\.json\s+\d+x\d+/.test(l)) || "");
  const imgW = size ? Number(size[1]) : 0;
  const imgH = size ? Number(size[2]) : 0;
  const outline = cleanOutline(out);
  const labels = (outline.match(/"[^"]*"/g) || []).length;
  const scale = imgW ? width / imgW : 1;
  const header = [
    `# Erazer: the attached screenshot as widgets`,
    `# image ${imgW}x${imgH}px; the screen is ${width}px wide, so multiply sizes by ${scale.toFixed(3)}.`,
    `# role x,y WxH fill "label" font=size ink=text-colour r=radius — nesting is containment.`,
    `# ${words ? "labels read by Tesseract (noisy: fix obvious typos)" : "no OCR on this machine: labels are missing, read them from the picture"}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, ERAZER_TXT), `${header}${outline}\n`);
  return { widgets: outline ? outline.split("\n").length : 0, labels, ocr: Boolean(words), imgW, imgH, scale };
}

export const PICTURE_FILES = [ERAZER_TXT, ERAZER_JSON, WORDS_TSV];

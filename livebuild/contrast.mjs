/**
 * Text a person cannot read.
 *
 * `measure` answers overlap, overflow and alignment; it never looked at
 * colour, and an agent switching a screen to dark mode repaints the text
 * first and the cards later — white titles on white cards for a whole turn,
 * or for good. This reads the display list the page paints: for each text,
 * the fills drawn under its centre before it, composited, against the text's
 * own colour, as a WCAG contrast ratio.
 *
 *   contrastFindings(list)    → [{text: "\"Hei Maailma!\" 1.0:1 — #ffffff on #ffffff (needs 4.5)", unreadable: true}, …]
 *   contrastOf(docPath, view) → the same, laying the document out first
 *
 * Under 3:1 is unreadable: a finding, like an overlap. Between 3 and the
 * WCAG line (4.5, or 3 for large text) is reported and left to the agent.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root } from "./paths.mjs";

const RECT = 0;
const IMAGE = 2;
const TEXT = 3;

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function over(top, under) {
  const a = top[3] == null ? 1 : Number(top[3]);
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a));
}

const hex = (c) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

const inside = (cmd, x, y) => x >= cmd.x && x <= cmd.x + cmd.w && y >= cmd.y && y <= cmd.y + cmd.h;

export function contrastFindings(list, { limit = 8, page = [255, 255, 255] } = {}) {
  const cmds = (list && list.cmds) || [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < cmds.length; i += 1) {
    const t = cmds[i];
    if (!t || t.k !== TEXT || !Array.isArray(t.c) || !String(t.text || "").trim()) continue;
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    let bg = page;
    let onImage = false;
    for (let j = 0; j < i; j += 1) {
      const r = cmds[j];
      if (!r || !inside(r, cx, cy)) continue;
      if (r.k === IMAGE) onImage = true;
      if (r.k === RECT && Array.isArray(r.c)) {
        bg = over(r.c, bg);
        onImage = onImage && (r.c[3] == null ? 1 : r.c[3]) < 1;
      }
    }
    if (onImage) continue;
    const fg = over(t.c, bg);
    const large = (t.size || 0) >= 24 || ((t.size || 0) >= 18.5 && /bold|[6-9]00/.test(String(t.weight || t.font || "")));
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got >= need) continue;
    const words = String(t.text).trim().slice(0, 40);
    if (seen.has(words)) continue;
    seen.add(words);
    out.push({ text: `"${words}" ${got.toFixed(1)}:1 — ${hex(fg)} on ${hex(bg)} (needs ${need})`, unreadable: got < 3 });
    if (out.length >= limit) break;
  }
  return out;
}

export function contrastOf(docPath, view = null) {
  const args = [path.join(root, "gallery/evg/bin/evg_livebuild.js"), "frame", docPath];
  if (view && view.width) args.push(`--width=${view.width}`);
  if (view && view.height) args.push(`--height=${view.height}`);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
  for (const line of String(r.stdout || "").split("\n")) {
    if (!line.includes('"t":"frame"')) continue;
    try {
      return contrastFindings(JSON.parse(line).list);
    } catch {
      return [];
    }
  }
  return [];
}

// A measure event with the contrast folded in: unreadable text joins the
// findings, the rest is listed under `contrast`.
export function withContrast(measure, list) {
  const found = contrastFindings(list);
  if (!found.length || !measure) return measure;
  const bad = found.filter((f) => f.unreadable).map((f) => `text unreadable: ${f.text}`);
  const low = found.filter((f) => !f.unreadable).map((f) => f.text);
  const out = { ...measure };
  if (bad.length) {
    out.findings = [...(measure.findings || []), ...bad];
    out.count = (measure.count || 0) + bad.length;
  }
  if (low.length) out.contrast = low;
  return out;
}

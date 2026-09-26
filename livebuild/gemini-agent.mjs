#!/usr/bin/env node
/**
 * Gemini as a live-build agent, over the Gemini API — no CLI.
 *
 *   node gemini-agent.mjs <workspace>
 *
 *   GEMINI_API_KEY (or GOOGLE_API_KEY)   Google AI Studio key
 *   EVG_GEMINI_MODEL                     default gemini-3.8-flash
 *   EVG_GEMINI_MAX_TURNS                 model calls per task, default 40
 *   GEMINI_API_BASE                      default the public v1beta endpoint
 *
 * The CLI agents (Cursor, Claude) get a shell and AGENTS.md and find their
 * own way. Gemini Flash did not: handed a `run` tool and a wall of rules it
 * explored, planned in prose and ran out of output before calling anything,
 * or rewrote a dashboard as a settings list. The earlier adapter answered
 * each failure with another prohibition. This one changes what the model is
 * asked to do instead:
 *
 * - Every turn MUST be a function call (`functionCallingConfig: ANY`), and
 *   the run ends when the model calls `finish`. "A plan with no tool call"
 *   cannot happen, so nothing has to detect it.
 * - The tools are the verbs of the job, typed: `apply_ops` takes the ops
 *   themselves (no write-a-file-then-patch), `add_piece` adds a kit piece
 *   AND applies it, `measure` knows the screen size.
 * - Common spelling mistakes are repaired, not rejected. `padding: 16px` is
 *   four properties, `children` on an insert is its node, `set-prop id` is
 *   `set-id`, `box-shadow` is dropped with a note. A rejected batch costs a
 *   turn and teaches nothing; a repaired one says what it changed.
 * - `finish` is checked: an empty screen or open `measure` findings are
 *   answered once with what is wrong, and a second `finish` is accepted.
 * - A picture arrives in the first message: the pixels, and Erazer's
 *   widget outline (picture.mjs), which is what "rebuild this" needs.
 *
 * Stdout is the `stream-json` shape Cursor and Claude emit, so the page's
 * thinking panel and spend line read it with the parser they already have.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { quickStart, viewOf } from "./guide.mjs";
import { root } from "./paths.mjs";
import { ERAZER_TXT } from "./picture.mjs";
import { capabilities } from "./capabilities.mjs";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_HISTORY = ".gemini-history.json";
export const GEMINI_TRACE = ".gemini-trace.log";
// The host's record of applied batches, read by agents.mjs `watchOps`. The
// shell shim writes it for CLI agents; this process writes it itself.
const OPS_LOG = ".applied-ops.log";

const DEFAULT_MAX_TURNS = 40;
const RESULT_CAP = 8000;
const KEEP_FULL_RESULTS = 10;
const IMAGE_INLINE_MAX = 4_000_000;

// Paid-tier Flash prices per 1M tokens, overridable. The page shows the
// figure as "about", because the rate card is Google's to change.
const RATES = { input: 0.75, cache: 0.075, output: 3.75 };

export function geminiKey(env = process.env) {
  return String(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim();
}

export function geminiModel(env = process.env) {
  return String(env.EVG_GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
}

export function geminiBase(env = process.env) {
  return String(env.GEMINI_API_BASE || DEFAULT_GEMINI_BASE).replace(/\/+$/, "");
}

export function geminiRates(env = process.env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
  return {
    input: n(env.EVG_GEMINI_INPUT_PER_M, RATES.input),
    cache: n(env.EVG_GEMINI_CACHE_PER_M, RATES.cache),
    output: n(env.EVG_GEMINI_OUTPUT_PER_M, RATES.output),
  };
}

// --- the tools -----------------------------------------------------------------

const ALL_PIECES = ["appbar", "tabbar", "card", "row", "tiles", "bars", "banner", "pills", "chips", "actions", "field"];
// Only what the linked kit really has: an enum naming a piece that is not
// there is a promise the first call breaks.
function pieces() {
  const have = capabilities().pieces;
  return have.length ? ALL_PIECES.filter((p) => have.includes(p)) : ALL_PIECES;
}
const OPS = ["set-prop", "set-text", "set-id", "set-css", "insert", "remove", "move"];

const OP_SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", enum: OPS },
    at: { type: "string", description: "Address: 0 is the root, 0/2 its third child. For insert, the PARENT." },
    prop: { type: "string", description: "set-prop: one CSS property name, e.g. padding-left." },
    value: { type: "string", description: "set-prop / set-text / set-id / set-css: the new value." },
    index: { type: "integer", description: "insert / move: position among the parent's children." },
    to: { type: "string", description: "move: the new parent." },
    node: {
      type: "object",
      description: 'insert: the subtree, document shape: {"tag":"div","id":"…","props":{…},"children":[{"tag":"span","text":"…"}]}',
    },
  },
  required: ["op"],
};

// Two spellings of the same tools. The JSON-schema one lets `node` be a free
// object; an endpoint that refuses it gets the string one, where the ops
// travel as JSON text. The host reads both.
export function toolDeclarations(mode = "json") {
  const decl = (name, description, schema) =>
    mode === "json" ? { name, description, parametersJsonSchema: schema } : { name, description, parameters: schema };
  const opsParam =
    mode === "json"
      ? { ops: { type: "array", items: OP_SCHEMA, description: "The batch. All or nothing." } }
      : { ops_json: { type: "string", description: 'The batch as JSON text: [{"op":"set-prop","at":"0","prop":"gap","value":"12px"}, …]' } };
  return [
    decl("outline", "The document as one line per node: address, tag, #id, .class, text, and the properties it sets.", {
      type: "object",
      properties: {
        at: { type: "string", description: "Only this subtree." },
        depth: { type: "integer", description: "How deep to go." },
        file: { type: "string", description: "Default doc.evg.json; an app page is app/pages/<state>.evg.json." },
      },
    }),
    decl(
      "apply_ops",
      "Apply a batch of edit ops to the document and lay it out. Returns what was applied, anything the host repaired, and the layout findings.",
      {
        type: "object",
        properties: {
          ...opsParam,
          file: { type: "string", description: "Default doc.evg.json." },
        },
        required: [mode === "json" ? "ops" : "ops_json"],
      },
    ),
    decl(
      "add_piece",
      "Insert a finished, styled kit piece (with its stylesheet rules) and apply it. Use for app bars, tab bars, settings lists, metric tiles, charts, banners, segmented pills, action buttons and form fields.",
      {
        type: "object",
        properties: {
          piece: { type: "string", enum: pieces() },
          flags: {
            type: "array",
            items: { type: "string" },
            description: 'The piece\'s flags as separate strings: ["--title", "Orders", "--tile", "Revenue|$12.4k|+8%|$"]. kit_spec lists them.',
          },
          at: { type: "string", description: "Parent address. Default: the root." },
          index: { type: "integer", description: "Position among the parent's children. Default: the end." },
        },
        required: ["piece"],
      },
    ),
    decl("kit_spec", "Without a name: every piece's flags and classes, and the list of controls, in one answer. With a name: that one.", {
      type: "object",
      properties: { name: { type: "string" } },
    }),
    decl(
      "measure",
      "Lay the document out at the screen size and report defects: findings (overlap, overflow, off the page), align (rows that do not line up), tight (crowded neighbours), bottomFree (room left).",
      {
        type: "object",
        properties: {
          at: { type: "string", description: "With boxes: only this subtree." },
          boxes: { type: "boolean", description: "Also list each node's box {x,y,w,h,gapNext}." },
          file: { type: "string" },
        },
      },
    ),
    decl("app", "Run ./evg-app for a multi-screen app: init, states, check, press, render, memo. AGENTS.md explains it.", {
      type: "object",
      properties: { args: { type: "array", items: { type: "string" }, description: 'e.g. ["check", "app"]' } },
      required: ["args"],
    }),
    decl("read_file", "Read a text file in the workspace: AGENTS.md (the full guide), attachment.erazer.txt, layout.json.", {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    }),
    decl("finish", "The screen does what the task asked. Say what you built in one or two sentences.", {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    }),
  ];
}

export function systemPrompt(view, maxTurns = DEFAULT_MAX_TURNS) {
  return `You are designing an application screen in an EVG document. You act only through the tools; every reply is a tool call. The run ends when you call finish.

${quickStart(view, GEMINI_TOOLS_TEXT, capabilities())}
## When a screenshot is attached

It is a reference, not the result. Its pixels are in the first message, and so is Erazer's reading of it: one line per widget, nested by containment, with position, size, fill, label, font size, text colour and radius. Rebuild that structure with the rules above — rows and columns, kit pieces where they fit, the screenshot's colours and words — scaled to this screen.

## How to work

You have ${maxTurns} tool calls for the whole task, and every result says how many are left. Spend them on edits.

- The first message already has the task, the document's outline and any screenshot. Do not call outline or kit_spec to look around: the table above is the kit.
- Build in big steps. The first version of the screen is one to three calls — an apply_ops batch can carry the whole structure and the stylesheet (fifty ops is fine), and add_piece adds a finished piece.
- Every apply_ops and add_piece result already contains the new outline and the layout findings. Do not follow an edit with outline or measure; read the result and make the next edit.
- Change what is there in place — set-text, set-prop, set-css. Do not remove a piece and add it again.
- Fix findings before moving on. Do not repeat a call whose answer you already have.
- When the screen has everything the task asked for and no findings, call finish.
- The full reference is AGENTS.md (read_file) — only when something here is not enough.`;
}

const GEMINI_TOOLS_TEXT = {
  patchIntro: "Call apply_ops with the batch. The answer carries the layout findings.",
  kitIntro:
    "add_piece inserts a finished, styled piece with its stylesheet rules, and applies it: add_piece(piece, flags, at, index). kit_spec(name) lists a piece's flags.",
  kitList: "kit_spec with no name",
  outline: "outline",
  measure: "measure",
  finish: "finish(summary) when the outline shows every part of the ask and measure has no findings.",
};

// --- repairing ops -----------------------------------------------------------

const DROP = new Set([
  "box-shadow", "z-index", "letter-spacing", "text-transform", "text-decoration", "font-style",
  "align-self", "justify-self", "box-sizing", "border-style", "text-overflow", "transition-duration",
  "outline", "filter", "backdrop-filter", "vertical-align", "word-break", "user-select", "content",
]);

const LENGTH = /^(width|height|min-width|max-width|min-height|max-height|gap|top|left|right|bottom|font-size|border-radius|border-width|line-height|flex-basis|(padding|margin)-(top|right|bottom|left))$/;

function kebab(name) {
  return String(name).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).trim();
}

function sides(value) {
  const v = String(value).trim().split(/\s+/);
  const [t, r = t, b = t, l = r] = v;
  return { top: t, right: r, bottom: b, left: l };
}

const isColor = (v) => /^(#|rgb|hsl)|^[a-z]+$/i.test(String(v).trim()) && !/gradient/i.test(String(v));

// One property, spelled any way a model tends to spell it, as the list of
// properties EVG can take. `notes` says what changed.
export function repairProp(name, value, notes) {
  let prop = kebab(name);
  let val = value == null ? "" : String(value);
  if (typeof value === "number" && LENGTH.test(prop) && prop !== "line-height") val = `${value}px`;
  if (/^\d+(\.\d+)?$/.test(val) && LENGTH.test(prop) && prop !== "line-height" && val !== "0") val = `${val}px`;
  if (prop === "padding" || prop === "margin") {
    const s = sides(val);
    notes.push(`${prop}: ${val} → ${prop}-top/right/bottom/left`);
    return ["top", "right", "bottom", "left"].map((k) => [`${prop}-${k}`, s[k]]);
  }
  if (prop === "border") {
    const parts = val.split(/\s+/);
    const width = parts.find((p) => /^\d/.test(p)) || "1px";
    const color = parts.find((p) => /^(#|rgb|hsl)/.test(p)) || parts.filter((p) => !/^\d|solid|dashed|dotted|none/.test(p))[0];
    notes.push(`border: ${val} → border-width${color ? " + border-color" : ""}`);
    return color ? [["border-width", width], ["border-color", color]] : [["border-width", width]];
  }
  if (prop === "background" || prop === "background-image") {
    const to = /gradient/i.test(val) ? "background-gradient" : isColor(val) ? "background-color" : "";
    if (!to) {
      notes.push(`${prop}: ${val} dropped (not supported)`);
      return [];
    }
    notes.push(`${prop} → ${to}`);
    return [[to, val]];
  }
  if (prop === "flex") {
    const grow = val.split(/\s+/)[0];
    notes.push(`flex: ${val} → flex-grow: ${grow}`);
    return [["flex-grow", grow]];
  }
  if (prop === "row-gap" || prop === "column-gap" || prop === "grid-gap") {
    notes.push(`${prop} → gap`);
    return [["gap", val]];
  }
  if (prop === "class") return [["class-name", val]];
  if (DROP.has(prop)) {
    notes.push(`${prop} dropped (not supported)`);
    return [];
  }
  return [[prop, val]];
}

function repairNode(node, notes, where) {
  if (!node || typeof node !== "object") return node;
  const out = { tag: String(node.tag || node.type || "div").toLowerCase() };
  if (!["div", "span", "img", "path", "svg", "text"].includes(out.tag)) {
    notes.push(`${where}: tag ${out.tag} → ${node.text != null ? "span" : "div"}`);
    out.tag = node.text != null ? "span" : "div";
  }
  if (node.id != null && node.id !== "") out.id = String(node.id);
  if (node.key != null) out.key = String(node.key);
  const props = {};
  const src = { ...(node.style && typeof node.style === "object" ? node.style : {}), ...(node.props || {}) };
  if (node.class || node.className || node["class-name"]) src["class-name"] = node.class || node.className || node["class-name"];
  if (src.id != null && out.id == null) {
    out.id = String(src.id);
    delete src.id;
  }
  for (const [k, v] of Object.entries(src)) {
    for (const [pk, pv] of repairProp(k, v, notes)) props[pk] = pv;
  }
  if (Object.keys(props).length) out.props = props;
  const kids = Array.isArray(node.children) ? node.children : [];
  let text = node.text ?? node.textContent;
  if (text != null && kids.length) {
    notes.push(`${where}: a node with text and children — the text became a first span`);
    kids.unshift({ tag: "span", text });
    text = undefined;
  }
  if (text != null) {
    out.text = String(text);
    if (out.tag === "div") out.tag = "span";
  }
  if (kids.length) out.children = kids.map((k, i) => repairNode(k, notes, `${where}/${i}`));
  return out;
}

/**
 * The batch as EVG takes it. Returns { ops, notes }: the repaired ops, and a
 * line for each repair so the model learns the spelling rather than being
 * told "rejected".
 */
export function repairOps(input) {
  const notes = [];
  let list = input;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch (e) {
      return { ops: [], notes, error: `ops_json is not JSON: ${e.message}` };
    }
  }
  if (list && !Array.isArray(list) && Array.isArray(list.ops)) list = list.ops;
  if (list && !Array.isArray(list) && typeof list === "object") list = [list];
  if (!Array.isArray(list)) return { ops: [], notes, error: "ops must be a list of op objects" };
  const ops = [];
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const o = { ...raw };
    o.op = String(o.op || o.type || "").toLowerCase().replace(/_/g, "-");
    if (o.op === "delete") o.op = "remove";
    if (o.op === "set-style" || o.op === "set") o.op = "set-prop";
    if (o.op === "add" || o.op === "append") o.op = "insert";
    if (o.path && !o.at) o.at = o.path;
    o.at = String(o.at ?? "0").replace(/^\/+|\/+$/g, "") || "0";
    if (o.op === "set-prop") {
      const name = kebab(o.prop || o.name || o.property || "");
      if (name === "id") {
        ops.push({ op: "set-id", at: o.at, value: String(o.value) });
        notes.push(`op ${i}: set-prop id → set-id`);
        return;
      }
      if (name === "text") {
        ops.push({ op: "set-text", at: o.at, value: String(o.value) });
        notes.push(`op ${i}: set-prop text → set-text`);
        return;
      }
      const themed = /^theme-([\w-]+)$/.exec(String(o.value || "").trim());
      if (name === "class-name" && themed) {
        ops.push({ op: "set-prop", at: o.at, prop: "theme", value: themed[1] });
        notes.push(`op ${i}: class-name ${o.value} → theme ${themed[1]} (what .theme-${themed[1]} rules match)`);
        return;
      }
      if (!name && o.props && typeof o.props === "object") {
        for (const [k, v] of Object.entries(o.props)) {
          for (const [pk, pv] of repairProp(k, v, notes)) ops.push({ op: "set-prop", at: o.at, prop: pk, value: pv });
        }
        return;
      }
      for (const [pk, pv] of repairProp(name, o.value, notes)) ops.push({ op: "set-prop", at: o.at, prop: pk, value: String(pv) });
      return;
    }
    if (o.op === "insert") {
      let node = o.node || o.tree || o.element;
      if (typeof node === "string") {
        try {
          node = JSON.parse(node);
        } catch {
          node = null;
        }
      }
      if (!node && (o.tag || o.children || o.text != null || o.props)) {
        node = { tag: o.tag || "div", id: o.id, text: o.text, props: o.props, children: o.children };
        if (o.children || o.text != null || o.props) notes.push(`op ${i}: insert fields moved into node`);
      }
      if (!node) {
        notes.push(`op ${i}: insert without a node skipped`);
        return;
      }
      const index = Number.isInteger(o.index) ? o.index : Number.isFinite(Number(o.index)) ? Number(o.index) : -1;
      ops.push({ op: "insert", at: o.at, index, node: repairNode(node, notes, `op ${i}`) });
      return;
    }
    if (o.op === "move") {
      ops.push({ op: "move", at: o.at, to: String(o.to || o.toPath || o.parent || "0"), index: Number(o.index) || 0 });
      return;
    }
    if (o.op === "set-css") {
      ops.push({ op: "set-css", at: "0", value: String(o.value ?? o.css ?? "") });
      return;
    }
    if (o.op === "set-text" || o.op === "set-id") {
      ops.push({ op: o.op, at: o.at, value: String(o.value ?? o.text ?? o.id ?? "") });
      return;
    }
    if (o.op === "remove") {
      ops.push({ op: "remove", at: o.at });
      return;
    }
    notes.push(`op ${i}: unknown op "${raw.op}" skipped — ops are ${OPS.join(", ")}`);
  });
  return { ops, notes };
}

// An insert without an index goes at the end, which EVG spells as the
// parent's child count.
function childCount(doc, at) {
  let n = doc && doc.root;
  for (const step of String(at).split("/").slice(1)) {
    if (!n || !Array.isArray(n.children)) return 0;
    n = n.children[Number(step)];
  }
  return n && Array.isArray(n.children) ? n.children.length : 0;
}

// --- running the workspace tools ---------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function clip(text, cap = RESULT_CAP) {
  const s = String(text ?? "");
  return s.length > cap ? `${s.slice(0, cap)}\n… (${s.length - cap} more characters)` : s;
}

function node(workspace, args, timeout = 90000) {
  const r = spawnSync(process.execPath, args, {
    cwd: workspace,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
}

function firstJson(text) {
  const s = String(text || "");
  const i = s.indexOf("{");
  if (i < 0) return null;
  try {
    return JSON.parse(s.slice(i));
  } catch {
    return null;
  }
}

function safeRel(workspace, rel, fallback = "doc.evg.json") {
  const p = String(rel || fallback).trim() || fallback;
  const abs = path.resolve(workspace, p);
  if (!abs.startsWith(path.resolve(workspace) + path.sep) && abs !== path.resolve(workspace)) {
    throw new Error(`${p} is outside the workspace`);
  }
  return path.relative(workspace, abs);
}

function agentJs(workspace) {
  const local = path.join(workspace, "evg_agent.js");
  return fs.existsSync(local) ? local : path.join(root, "lib/evg/bin/evg_agent.js");
}

function recordOps(workspace, ops) {
  try {
    fs.appendFileSync(path.join(workspace, OPS_LOG), `${JSON.stringify(ops)}\n`);
  } catch {
    /* the panel is a convenience */
  }
}

function applyBatch(workspace, file, ops) {
  const docPath = path.join(workspace, file);
  const doc = readJson(docPath);
  if (!doc) return { ok: false, error: `${file} is not a document` };
  for (const o of ops) if (o.op === "insert" && o.index < 0) o.index = childCount(doc, o.at);
  const tmp = path.join(workspace, ".gemini-ops.json");
  fs.writeFileSync(tmp, JSON.stringify({ ops }));
  const r = node(workspace, [agentJs(workspace), "patch", file, tmp]);
  const j = firstJson(r.stdout);
  if (!j) return { ok: false, error: clip(r.stderr || r.stdout || "patch said nothing", 1500) };
  if (j.ok && file === "doc.evg.json") recordOps(workspace, ops);
  const out = { ok: Boolean(j.ok), applied: j.applied || 0 };
  if (j.rejected) out.rejected = j.rejected;
  if (j.error) out.error = j.error;
  if (j.atDefault) out.atDefault = "some values equal the tag default and vanish from the file — they still applied";
  if (j.layout) out.layout = j.layout;
  if (!j.ok) out.hint = "Nothing was applied. Fix the rejected op and send the batch again.";
  return out;
}

function measureDoc(workspace, file, view, { at, boxes } = {}) {
  const args = [agentJs(workspace), "measure", file, `--width=${view.width}`, `--height=${view.height}`];
  if (boxes) args.push("--boxes");
  if (at) args.push(`--at=${at}`);
  const r = node(workspace, args);
  return firstJson(r.stdout) || { error: clip(r.stderr || r.stdout, 1500) };
}

function outlineDoc(workspace, file, { at, depth } = {}) {
  const args = [agentJs(workspace), "outline", file];
  if (at) args.push(`--at=${at}`);
  if (depth) args.push(`--depth=${depth}`);
  const r = node(workspace, args);
  return r.ok ? { outline: clip(r.stdout, 12000) } : { error: clip(r.stderr || r.stdout, 1500) };
}

// Flags arrive as a list, and sometimes as one string, and sometimes as
// "--title Orders" in one element. All three become argv.
export function normalizeFlags(flags) {
  const list = typeof flags === "string" ? [flags] : Array.isArray(flags) ? flags.map(String) : [];
  const out = [];
  for (const item of list) {
    const t = item.trim();
    if (/\s--[\w-]+/.test(t)) {
      const re = /(--[\w-]+)|"([^"]*)"|'([^']*)'|(\S+)/g;
      let m;
      while ((m = re.exec(t))) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
      continue;
    }
    const m = /^(--[\w-]+)(?:=|\s+)([\s\S]+)$/.exec(t);
    if (m) {
      out.push(m[1], m[2].replace(/^["']|["']$/g, ""));
      continue;
    }
    out.push(item);
  }
  return out;
}

function kit(workspace, argv) {
  return node(workspace, [path.join(root, "gallery/ui/kit/ui_kit.mjs"), ...argv], 60000);
}

function addPiece(workspace, args) {
  const piece = String(args.piece || "").trim();
  if (!pieces().includes(piece)) return { ok: false, error: `piece is one of ${pieces().join(", ")}` };
  const argv = ["add", piece, ...normalizeFlags(args.flags), "--into", "doc.evg.json"];
  if (args.at) argv.push("--at", String(args.at));
  if (Number.isInteger(args.index)) argv.push("--index", String(args.index));
  const r = kit(workspace, argv);
  const j = firstJson(r.stdout);
  if (!j || !Array.isArray(j.ops)) {
    return { ok: false, error: clip(r.stderr || r.stdout || "the kit said nothing", 1500), hint: `kit_spec("${piece}") lists the flags` };
  }
  const res = applyBatch(workspace, "doc.evg.json", j.ops);
  if (res.ok) {
    res.added = piece;
    res.classes = j.classes;
    res.hint = "Restyle it through its classes in the stylesheet (set-css).";
    res.outline = outlineDoc(workspace, "doc.evg.json").outline;
  }
  return res;
}

function runApp(workspace, argv) {
  const shim = path.join(workspace, "evg-app");
  if (!fs.existsSync(shim)) return { ok: false, error: "./evg-app is not in this workspace" };
  const r = spawnSync("sh", [shim, ...argv.map(String)], { cwd: workspace, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: clip(`${r.stdout || ""}${r.stderr ? `\n${r.stderr}` : ""}`.trim(), RESULT_CAP) };
}

function readFile(workspace, rel) {
  const p = safeRel(workspace, rel, "");
  if (/\.evg\.json$/.test(p)) return { error: "use outline for a document — it has the addresses" };
  const abs = path.join(workspace, p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { error: `no file ${p}` };
  return { path: p, contents: clip(fs.readFileSync(abs, "utf8"), 30000) };
}

function nodeCount(n) {
  if (!n || typeof n !== "object") return 0;
  return 1 + (n.children || []).reduce((s, c) => s + nodeCount(c), 0);
}

/**
 * One tool call. `state` carries what a run remembers between calls: the
 * view, whether finish was already questioned.
 */
export function executeTool(workspace, name, args, state) {
  const view = state.view;
  try {
    switch (name) {
      case "outline":
        return outlineDoc(workspace, safeRel(workspace, args.file), args);
      case "apply_ops": {
        const { ops, notes, error } = repairOps(args.ops ?? args.ops_json);
        if (error) return { ok: false, error };
        if (!ops.length) return { ok: false, error: "no ops to apply", repaired: notes };
        const file = safeRel(workspace, args.file);
        const res = applyBatch(workspace, file, ops);
        if (res.ok) res.outline = outlineDoc(workspace, file).outline;
        if (notes.length) res.repaired = notes;
        return res;
      }
      case "add_piece":
        return addPiece(workspace, args);
      case "kit_spec": {
        if (args.name) {
          const r = kit(workspace, ["spec", String(args.name)]);
          return { out: clip(r.stdout || r.stderr, 6000) };
        }
        // One answer instead of a call per piece: the run this replaced
        // spent seven turns asking for them one at a time.
        const specs = pieces().map((p) => (kit(workspace, ["spec", p]).stdout || "").trim());
        const list = kit(workspace, ["list"]).stdout || "";
        const controls = list.slice(list.indexOf("CONTROLS"));
        return { out: clip(`${specs.join("\n\n")}\n\n${controls}`, 14000) };
      }
      case "measure":
        return measureDoc(workspace, safeRel(workspace, args.file), view, args);
      case "app":
        return runApp(workspace, Array.isArray(args.args) ? args.args : normalizeFlags(args.args));
      case "read_file":
        return readFile(workspace, args.path);
      case "finish": {
        if (state.finishChecked) return { ok: true, done: true };
        state.finishChecked = true;
        const doc = readJson(path.join(workspace, "doc.evg.json"));
        const m = measureDoc(workspace, "doc.evg.json", view);
        const problems = [];
        if (nodeCount(doc && doc.root) < 4) problems.push("the screen is still (almost) empty");
        if (m && m.count > 0) problems.push(`measure reports ${m.count} finding(s): ${(m.findings || []).slice(0, 5).join("; ")}`);
        if (!problems.length) return { ok: true, done: true };
        return {
          ok: false,
          done: false,
          problems,
          hint: "Fix these, or call finish again to stop as it is.",
        };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// --- the conversation --------------------------------------------------------

function pictureParts(workspace) {
  const parts = [];
  const img = ["attachment.png", "attachment.jpg"].find((f) => fs.existsSync(path.join(workspace, f)));
  if (!img) return { parts, text: "" };
  const bytes = fs.statSync(path.join(workspace, img)).size;
  if (bytes <= IMAGE_INLINE_MAX) {
    parts.push({
      inlineData: {
        mimeType: img.endsWith(".png") ? "image/png" : "image/jpeg",
        data: fs.readFileSync(path.join(workspace, img)).toString("base64"),
      },
    });
  }
  const bits = ["## The attached screenshot", `The image is ${img}${bytes <= IMAGE_INLINE_MAX ? ", attached here" : " (too large to attach)"}.`];
  const palette = readJson(path.join(workspace, "attachment.json"));
  if (palette && Array.isArray(palette.colors)) {
    bits.push(`Its colours by area: ${palette.colors.slice(0, 8).map((c) => `${c.hex} ${Math.round((c.share || 0) * 100)}%`).join(", ")}.`);
  }
  const erazer = path.join(workspace, ERAZER_TXT);
  if (fs.existsSync(erazer)) {
    bits.push("Erazer's reading of it:", "```", clip(fs.readFileSync(erazer, "utf8"), 9000), "```");
  }
  return { parts, text: bits.join("\n") };
}

function loadHistory(workspace) {
  const h = readJson(path.join(workspace, GEMINI_HISTORY));
  return h && Array.isArray(h.runs) ? h : { runs: [] };
}

function saveHistory(workspace, history) {
  try {
    fs.writeFileSync(path.join(workspace, GEMINI_HISTORY), `${JSON.stringify(history, null, 2)}\n`);
  } catch {
    /* a follow-up without memory still has the document */
  }
}

// Earlier results are the bulk of every request, and the model only needs the
// recent ones verbatim. Older function responses shrink to their verdict;
// the function CALLS (and their thought signatures) are never touched.
export function compact(contents, keep = KEEP_FULL_RESULTS) {
  let seen = 0;
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const c = contents[i];
    if (c.role !== "user") continue;
    for (const p of c.parts || []) {
      if (!p.functionResponse) continue;
      seen += 1;
      if (seen <= keep) continue;
      const r = p.functionResponse.response || {};
      if (r.compacted) continue;
      p.functionResponse.response = {
        compacted: true,
        ok: r.ok,
        error: r.error ? clip(r.error, 200) : undefined,
        findings: r.layout ? r.layout.count : r.count,
      };
    }
  }
  return contents;
}

function usageOf(data) {
  const u = (data && data.usageMetadata) || {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const prompt = n(u.promptTokenCount);
  const cache = Math.min(n(u.cachedContentTokenCount), prompt);
  return { prompt, cache, fresh: prompt - cache, output: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount), thoughts: n(u.thoughtsTokenCount) };
}

export function costUsd(u, env = process.env) {
  const r = geminiRates(env);
  return (u.fresh * r.input + u.cache * r.cache + u.output * r.output) / 1e6;
}

async function post(url, key, body, fetchImpl, signal) {
  let wait = 2000;
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
      continue;
    }
    const err = new Error(`Gemini HTTP ${res.status}: ${(() => {
      try {
        return JSON.parse(text).error.message;
      } catch {
        return text.slice(0, 400);
      }
    })()}`);
    err.status = res.status;
    throw err;
  }
}

// A model id that is not served (a typo, a preview that ended) is a 404. The
// newest Flash the key can use is a better answer than stopping.
async function fallbackModel(base, key, fetchImpl, wanted) {
  const res = await fetchImpl(`${base}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
  if (!res.ok) return "";
  const j = await res.json();
  const names = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name || "").replace(/^models\//, ""))
    .filter((n) => /flash/.test(n) && !/lite|image|tts|audio|live|embedding/.test(n));
  const version = (n) => {
    const m = /gemini-(\d+(?:\.\d+)?)/.exec(n);
    return m ? Number(m[1]) : 0;
  };
  names.sort((a, b) => version(b) - version(a) || Number(/preview|exp/.test(a)) - Number(/preview|exp/.test(b)));
  return names.find((n) => n !== wanted) || "";
}

function summarize(name, args, result) {
  const a = args || {};
  let call = name;
  if (name === "apply_ops") {
    const n = Array.isArray(a.ops) ? a.ops.length : "?";
    call = `apply_ops ${n} op${n === 1 ? "" : "s"}${a.file ? ` → ${a.file}` : ""}`;
  } else if (name === "add_piece") call = `add_piece ${a.piece} ${normalizeFlags(a.flags).join(" ")}`.trim();
  else if (name === "app") call = `evg-app ${(a.args || []).join(" ")}`;
  else if (name === "outline" || name === "measure") call = `${name}${a.at ? ` --at=${a.at}` : ""}`;
  else if (name === "read_file") call = `read_file ${a.path}`;
  else if (name === "kit_spec") call = `kit_spec ${a.name || ""}`.trim();
  else if (name === "finish") call = "finish";
  let reply = "ok";
  if (result.error) reply = `error: ${String(result.error).slice(0, 200)}`;
  else if (result.ok === false && result.rejected) reply = `rejected: ${String(result.rejected[0]).slice(0, 200)}`;
  else if (result.problems) reply = `not yet: ${result.problems.join("; ").slice(0, 200)}`;
  else if (result.layout) reply = `applied ${result.applied}, ${result.layout.count} finding(s)`;
  else if (result.count != null) reply = `${result.count} finding(s), ${result.bottomFree}px free`;
  else if (result.outline) reply = `${result.outline.split("\n").filter((l) => /^\d/.test(l)).length} nodes`;
  if (result.repaired && result.repaired.length) reply += ` (repaired: ${result.repaired.length})`;
  return `${call} · ${reply}`;
}

/**
 * One task. `onEvent` receives stream-json objects; `log` is the console.
 */
export async function geminiLoop({ workspace, onEvent, env = process.env, fetchImpl = fetch, signal, log = () => {} }) {
  const key = geminiKey(env);
  if (!key) throw new Error("GEMINI_API_KEY is not set (https://aistudio.google.com/apikey). GOOGLE_API_KEY also works.");
  const base = geminiBase(env);
  let model = geminiModel(env);
  const maxTurns = Math.max(4, Number(env.EVG_GEMINI_MAX_TURNS) || DEFAULT_MAX_TURNS);
  const task = (() => {
    try {
      return fs.readFileSync(path.join(workspace, "TASK.md"), "utf8").trim();
    } catch {
      return "Improve the screen in doc.evg.json.";
    }
  })();
  const view = viewOf(task);
  const state = { view, finishChecked: false };
  const history = loadHistory(workspace);

  const earlier = history.runs.length
    ? `## Earlier in this session\n${history.runs.slice(-6).map((r, i) => `${i + 1}. ${r.task.split("\n")[0].slice(0, 200)} → ${r.summary}`).join("\n")}\n\n`
    : "";
  const outline = outlineDoc(workspace, "doc.evg.json");
  const pic = pictureParts(workspace);
  const first = [
    `${earlier}## Task\n${task}`,
    `## The document now\n\`\`\`\n${outline.outline || outline.error}\n\`\`\``,
    pic.text,
  ]
    .filter(Boolean)
    .join("\n\n");
  const contents = [{ role: "user", parts: [{ text: first }, ...pic.parts] }];

  let mode = env.EVG_GEMINI_TOOL_SCHEMA === "string" ? "string" : "json";
  const spend = { prompt: 0, cache: 0, fresh: 0, output: 0, thoughts: 0 };
  const started = Date.now();
  const lastCalls = [];
  let turns = 0;
  let summary = "";

  const trace = (line) => {
    log(line);
    try {
      fs.appendFileSync(path.join(workspace, GEMINI_TRACE), `${line}\n`);
    } catch {
      /* gone */
    }
  };
  const result = (subtype) => {
    const cost = costUsd(spend, env);
    onEvent({
      type: "result",
      subtype,
      num_turns: turns,
      duration_ms: Date.now() - started,
      total_cost_usd: cost,
      usage: { input_tokens: spend.fresh, output_tokens: spend.output, cache_read_input_tokens: spend.cache, cache_creation_input_tokens: 0 },
      modelUsage: { [model]: { costUSD: cost } },
    });
    return cost;
  };

  while (turns < maxTurns) {
    if (signal && signal.aborted) throw new Error("aborted");
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt(view, maxTurns) }] },
      contents: compact(contents),
      tools: [{ functionDeclarations: toolDeclarations(mode) }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
      generationConfig: {
        maxOutputTokens: Number(env.EVG_GEMINI_MAX_OUTPUT) || 32768,
        // Gemini's thought SUMMARIES are prose about its own reasoning ("Okay,
        // here's the summary, formatted as requested"), not the reasoning, and
        // they buried the tool calls on the page. The model thinks either way.
        thinkingConfig: { includeThoughts: env.EVG_GEMINI_THOUGHTS === "1" },
        ...(env.EVG_GEMINI_TEMPERATURE ? { temperature: Number(env.EVG_GEMINI_TEMPERATURE) } : {}),
      },
    };
    let data;
    try {
      data = await post(`${base}/models/${encodeURIComponent(model)}:generateContent`, key, body, fetchImpl, signal);
    } catch (e) {
      if (e.status === 404 && turns === 0) {
        const other = await fallbackModel(base, key, fetchImpl, model);
        if (other) {
          trace(`model ${model} is not available to this key — using ${other}`);
          onEvent({ type: "assistant", message: { content: [{ text: `${model} is not served; using ${other}.` }] } });
          model = other;
          continue;
        }
      }
      if (e.status === 400 && mode === "json" && /schema|parameters|properties|Unknown name/i.test(e.message)) {
        trace(`the endpoint refused JSON-schema tools (${e.message.slice(0, 160)}) — retrying with string ops`);
        mode = "string";
        continue;
      }
      throw e;
    }
    turns += 1;
    const u = usageOf(data);
    for (const k of Object.keys(spend)) spend[k] += u[k];
    const cand = data.candidates && data.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    if (!parts.length) {
      const why = (data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason) || "no content";
      if (why === "MAX_TOKENS" || why === "MALFORMED_FUNCTION_CALL") {
        trace(`turn ${turns}: ${why} — asking for a smaller call`);
        contents.push({ role: "user", parts: [{ text: `Your last call was cut off (${why}). Send a smaller batch: one section per apply_ops.` }] });
        continue;
      }
      throw new Error(`Gemini returned nothing (${why})`);
    }
    // Parts go back exactly as they came: Gemini 3 checks the thought
    // signatures on its own function calls.
    contents.push({ role: "model", parts });

    const calls = [];
    for (const p of parts) {
      if (p.functionCall) calls.push(p.functionCall);
      else if (p.text) {
        if (p.thought) trace(`think: ${p.text.replace(/\s+/g, " ").slice(0, 600)}`);
        onEvent({ type: "assistant", message: { content: [{ text: p.text }] } });
      }
    }
    if (!calls.length) {
      contents.push({ role: "user", parts: [{ text: "Call a tool: the next edit, or finish." }] });
      continue;
    }

    const responses = [];
    let done = false;
    for (const fc of calls) {
      const args = fc.args || {};
      const sig = `${fc.name}:${JSON.stringify(args)}`;
      lastCalls.push(sig);
      const res = executeTool(workspace, fc.name, args, state);
      const left = maxTurns - turns;
      res.turnsLeft = left;
      if (left <= 5 && fc.name !== "finish") {
        res.budget = `Only ${left} calls left. Put everything that is still missing into one batch, then call finish.`;
      }
      const repeats = lastCalls.slice(-4).filter((s) => s === sig).length;
      if (repeats >= 3 && fc.name !== "finish") {
        res.note = `This is the same call ${repeats} times in a row; its answer will not change. Take the next step.`;
      }
      const line = summarize(fc.name, args, res);
      trace(`→ ${line}`);
      onEvent({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: line } } } });
      const fr = { name: fc.name, response: res };
      if (fc.id) fr.id = fc.id;
      responses.push({ functionResponse: fr });
      if (fc.name === "finish" && res.done) {
        done = true;
        summary = String(args.summary || "").trim();
      }
    }
    contents.push({ role: "user", parts: responses });
    trace(`turn ${turns}: ${u.fresh} fresh + ${u.cache} cached in, ${u.output} out`);
    if (done) {
      if (summary) onEvent({ type: "assistant", message: { content: [{ text: summary }] } });
      history.runs.push({ task, summary: summary || "(no summary)", model, at: new Date().toISOString() });
      saveHistory(workspace, history);
      const cost = result("success");
      return { ok: true, turns, model, usage: spend, costUsd: cost };
    }
  }
  history.runs.push({ task, summary: `(stopped after ${turns} turns, unfinished)`, model, at: new Date().toISOString() });
  saveHistory(workspace, history);
  result("error_max_turns");
  throw new Error(`Gemini did not finish in ${maxTurns} turns (EVG_GEMINI_MAX_TURNS)`);
}

async function main() {
  const workspace = process.argv[2];
  if (!workspace) {
    process.stderr.write("usage: gemini-agent.mjs <workspace>\n");
    process.exit(2);
  }
  const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.stderr.write(`gemini: ${geminiModel()} → ${geminiBase()}\n`);
  try {
    const r = await geminiLoop({ workspace, onEvent: emit, log: (l) => process.stderr.write(`${l}\n`) });
    process.stderr.write(`gemini: finished in ${r.turns} turns, about $${r.costUsd.toFixed(4)}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    emit({ type: "assistant", message: { content: [{ text: e.message }] } });
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

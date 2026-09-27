#!/usr/bin/env node
/**
 * The Gemini adapter, without Google.
 *
 *   node gemini-check.mjs      (npm run check:gemini in EvgHarness)
 *
 * A loopback server plays the model: it answers with scripted function calls
 * and asserts on every request — tools forced, thought signatures sent back,
 * the document in the first message. The calls run against a real session
 * workspace, so what is checked is that the screen actually changed.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runTask, resetSession, sessionDir, snapshotSession, undoSession } from "./agents.mjs";
import { flowCss, geminiLoop, mergeCss, normalizeFlags, repairOps, toolDeclarations, wipeCheck } from "./gemini-agent.mjs";
import { contrastFindings } from "./contrast.mjs";
import { designView } from "./designview.mjs";

const assert = (ok, what) => {
  if (!ok) throw new Error(what);
};

// --- repairs, in isolation -----------------------------------------------------
{
  const { ops, notes } = repairOps([
    { op: "set-prop", at: "0", prop: "padding", value: "12px 16px" },
    { op: "set-prop", at: "0/1", prop: "id", value: "open.orders" },
    { op: "set-prop", at: "0/1", prop: "box-shadow", value: "0 1px 2px #000" },
    { op: "insert", at: "0", tag: "div", props: { class: "card", flex: "1" }, children: [{ tag: "span", text: "Hi" }] },
    { op: "insert", at: "0", node: { tag: "button", text: "Pay", props: { backgroundColor: "#2563eb", borderRadius: 8 } } },
    { op: "delete", at: "0/3" },
    { op: "set-prop", at: "0", prop: "class-name", value: "theme-dark" },
  ]);
  const props = ops.filter((o) => o.op === "set-prop" && /^padding/.test(o.prop)).map((o) => `${o.prop}=${o.value}`);
  assert(props.join(",") === "padding-top=12px,padding-right=16px,padding-bottom=12px,padding-left=16px", `padding: ${props}`);
  assert(ops.some((o) => o.op === "set-id" && o.value === "open.orders"), "set-prop id did not become set-id");
  const inserts = ops.filter((o) => o.op === "insert");
  assert(inserts[0].node.props["class-name"] === "card" && inserts[0].node.props["flex-grow"] === "1", "insert fields not moved into node");
  assert(inserts[0].node.children[0].text === "Hi", "children lost");
  assert(inserts[1].node.tag === "span" && inserts[1].node.props["border-radius"] === "8px", "button node not repaired");
  assert(ops.at(-2).op === "remove", "delete is remove");
  assert(ops.at(-1).prop === "theme" && ops.at(-1).value === "dark", "class-name theme-dark is the theme");
  assert(notes.some((n) => /box-shadow dropped/.test(n)), "a dropped property must be reported");
  const flags = normalizeFlags(['--title "Orders"', "--tile", "Revenue|$12k|+8%|$", '--bar "M|55" --bar "T|80"']);
  assert(JSON.stringify(flags) === JSON.stringify(["--title", "Orders", "--tile", "Revenue|$12k|+8%|$", "--bar", "M|55", "--bar", "T|80"]), `flags: ${flags}`);
  assert(toolDeclarations("json").every((d) => d.parametersJsonSchema), "json tools use parametersJsonSchema");
  assert(toolDeclarations("string").find((d) => d.name === "apply_ops").parameters.properties.ops_json, "string tools carry ops_json");
  const asText = repairOps([{ op: "insert", at: "0", node: '{"tag":"div","props":{"class-name":"card"},"children":[{"tag":"span","text":"Hi"}]}' }]);
  assert(asText.ops[0].node.children[0].text === "Hi", "a node sent as JSON text is the subtree");
  assert(/has no node/.test(repairOps([{ op: "insert", at: "0", node: {} }]).error || ""), "an empty node is refused, not inserted as an empty div");
  assert(repairOps([{ op: "remove", value: "0/2" }]).ops[0].at === "0/2", "a remove with its address in value removes that node");
  assert(/needs "at"/.test(repairOps([{ op: "remove" }]).error || ""), "a remove without an address is refused, not a remove of the root");
  const m = mergeCss(".ui-switch-track { background-color: #ccc }\n.ui-switch-track-state-checked { background-color: #0a0 }\n@media (max-width: 400px) { .a { gap: 4px } }", ".ui-switch-track { background-color: #ddd }\n.card { gap: 8px }");
  assert(m.changed === 1 && m.added === 1 && m.kept === 2 && /state-checked/.test(m.css) && /#ddd/.test(m.css) && /@media/.test(m.css), `css merge: ${JSON.stringify(m)}`);
  assert(toolDeclarations("json").find((d) => d.name === "apply_ops").parametersJsonSchema.properties.ops.items.properties.node.type === "string", "node is declared as a string");
  const flowNotes = [];
  const flowed = flowCss(".ui-row-title { display: block; position: relative; top: 0px; font-size: 16px }\n.fab { position: absolute; bottom: 16px }", flowNotes);
  assert(!/top:|position: relative/.test(flowed.split("\n")[0]) && /font-size: 16px/.test(flowed) && /bottom: 16px/.test(flowed) && flowNotes.length === 1, `flowCss: ${flowed}`);
  const cf = contrastFindings({ cmds: [
    { k: 0, x: 0, y: 0, w: 390, h: 100, c: [255, 255, 255, 1] },
    { k: 3, x: 10, y: 10, w: 80, h: 20, c: [255, 255, 255, 1], text: "Hei Maailma!", size: 16 },
    { k: 3, x: 10, y: 40, w: 80, h: 20, c: [0, 0, 0, 1], text: "Readable", size: 16 },
  ] });
  assert(cf.length === 1 && cf[0].unreadable && /Hei Maailma/.test(cf[0].text), `contrast: ${JSON.stringify(cf)}`);
  const view = designView(JSON.stringify({ evg: 1, root: { tag: "div", children: [{ tag: "div", checked: 2, props: { "class-name": "ui-switch ui-switch-state-{live}" }, children: [{ tag: "div", props: { "class-name": "ui-switch-track-state-{live}" } }] }] } }));
  assert(view && (view.match(/state-checked/g) || []).length === 2 && !/\{live\}/.test(view), `designView: ${view}`);
  console.log("  shapes      node as JSON text; empty node and address-less remove refused; set-css merges by selector");
  console.log("  view        relative insets dropped; unreadable text found; a bound switch drawn as it was asked for");
  const { quickStart } = await import("./guide.mjs");
  const bare = quickStart(undefined, undefined, { pieces: ["row", "card"], theme: false });
  assert(!/\| tiles \|/.test(bare) && /\| card \|/.test(bare), "the kit table lists only the pieces the kit has");
  assert(/ignores a document's `theme`/.test(bare), "an engine without themes is said so");
  console.log(`  repair      ${notes.length} repairs: shorthands, set-id, insert fields, dropped props; flags as argv`);
}

// --- a batch that would throw the screen away, and Undo ----------------------
{
  resetSession("dashboard");
  const dir = sessionDir();
  const file = path.join(dir, "doc.evg.json");
  const before = fs.readFileSync(file, "utf8");
  const kids = JSON.parse(before).root.children;
  const removeAll = kids.map((_, i) => ({ op: "remove", at: `0/${kids.length - 1 - i}` }));
  assert(wipeCheck(dir, "doc.evg.json", removeAll, false, "add a row"), "a batch removing every card must be refused");
  assert(wipeCheck(dir, "doc.evg.json", removeAll, true, "add a row"), "replace: true without a start-over ask is still refused");
  assert(!wipeCheck(dir, "doc.evg.json", removeAll, true, "Aloita alusta: tee kokonaan uusi näkymä"), "a task that asks to start over may");
  assert(!wipeCheck(dir, "doc.evg.json", [removeAll[0]], false, "tidy"), "removing one card is fine");
  snapshotSession();
  fs.writeFileSync(file, JSON.stringify({ evg: 1, root: { tag: "div", props: { width: "390px", height: "844px" } } }));
  assert(undoSession() && fs.readFileSync(file, "utf8") === before, "Undo puts the screen back");
  console.log("  wipe/undo   removing most of the screen is refused unless asked; Undo restores the snapshot");
}

// --- a whole run through the orchestrator ------------------------------------------

const call = (name, args, extra = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args }, ...extra }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 400, candidatesTokenCount: 50, thoughtsTokenCount: 20 },
});

const script = [
  (req) => {
    assert(req.toolConfig?.functionCallingConfig?.mode === "ANY", "tools must be forced");
    const names = req.tools[0].functionDeclarations.map((d) => d.name);
    for (const n of ["outline", "apply_ops", "add_piece", "measure", "finish"]) assert(names.includes(n), `tool ${n} missing`);
    assert(/What you are building/.test(req.systemInstruction.parts[0].text), "system prompt lacks the quick start");
    assert(/The document now/.test(req.contents[0].parts[0].text), "first message lacks the document");
    assert(req.generationConfig.temperature === undefined, "Gemini 3 runs at its default temperature");
    return call("finish", { summary: "nothing yet" }, { thoughtSignature: "sig-1" });
  },
  (req) => {
    const model = req.contents.find((c) => c.role === "model");
    assert(model.parts[0].thoughtSignature === "sig-1", "thought signature was not sent back");
    const fr = req.contents.at(-1).parts[0].functionResponse;
    assert(fr.name === "finish" && fr.response.done === false && /empty/.test(fr.response.problems.join(" ")), "an empty screen must not finish");
    return call("apply_ops", {
      ops: [
        { op: "set-prop", at: "0", prop: "padding", value: "16px" },
        { op: "set-prop", at: "0", prop: "gap", value: "12px" },
        { op: "insert", at: "0", tag: "span", text: "Northwind", props: { fontSize: 22, color: "#f8fafc" } },
      ],
    });
  },
  (req) => {
    const r = req.contents.at(-1).parts[0].functionResponse.response;
    assert(r.ok && r.applied >= 6, `apply_ops: ${JSON.stringify(r)}`);
    assert(r.repaired && r.repaired.length, "repairs are reported to the model");
    assert(/Northwind/.test(r.outline || "") && r.turnsLeft > 0, "an edit answers with the new outline and the turns left");
    return call("add_piece", { piece: "tiles", flags: ['--tile "Revenue|$12.4k|+8%|$"', "--tile", "Orders|1,284|this week|#"] });
  },
  (req) => {
    const r = req.contents.at(-1).parts[0].functionResponse.response;
    assert(r.ok && r.added === "tiles", `add_piece: ${JSON.stringify(r).slice(0, 300)}`);
    return call("measure", {});
  },
  (req) => {
    const r = req.contents.at(-1).parts[0].functionResponse.response;
    assert(r.width === 390 && r.height === 844, `measure uses the screen size: ${JSON.stringify(r).slice(0, 200)}`);
    return call("finish", { summary: "A Northwind header over two metric tiles." });
  },
];

let turn = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      assert(req.headers["x-goog-api-key"] === "test-key", "API key header missing");
      const step = script[turn++];
      assert(step, `unexpected request ${turn}`);
      const answer = JSON.stringify(step(JSON.parse(body)));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(answer);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `CHECK FAILED: ${e.message}` } }));
      failure = e;
    }
  });
});
let failure = null;
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const saved = { ...process.env };
Object.assign(process.env, {
  GEMINI_API_KEY: "test-key",
  GEMINI_API_BASE: `http://127.0.0.1:${server.address().port}/v1beta`,
  EVG_GEMINI_MODEL: "gemini-test-flash",
});
try {
  resetSession("empty");
  const events = [];
  await runTask({
    agent: "gemini",
    kind: "empty",
    prompt: "Build a dashboard for Northwind with revenue and orders.",
    session: true,
    onLine: (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        /* chatter */
      }
    },
  });
  if (failure) throw failure;
  assert(turn === script.length, `the run stopped after ${turn} of ${script.length} model calls`);
  const done = events.filter((e) => e.t === "done").at(-1);
  assert(done && done.ok, `done.ok: ${JSON.stringify(done)}`);
  const usage = events.find((e) => e.t === "usage");
  assert(usage && usage.turns === 5 && usage.costUsd > 0, `usage: ${JSON.stringify(usage)}`);
  assert(events.some((e) => e.t === "ops"), "applied ops never reached the page");
  const doc = JSON.parse(fs.readFileSync(path.join(sessionDir(), "doc.evg.json"), "utf8"));
  const text = JSON.stringify(doc);
  assert(/Northwind/.test(text) && /ui-tiles/.test(text) && /padding-left/.test(text), "the document did not get the edits");
  const history = JSON.parse(fs.readFileSync(path.join(sessionDir(), ".gemini-history.json"), "utf8"));
  assert(history.runs.at(-1).summary.startsWith("A Northwind header"), "history keeps the summary for a follow-up");
  console.log(`  run         ${turn} model calls: finish refused on empty, ops repaired and applied, a kit piece, measure, finish`);
} finally {
  server.close();
  for (const k of ["GEMINI_API_KEY", "GEMINI_API_BASE", "EVG_GEMINI_MODEL"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

// --- an unknown model, and an endpoint that refuses JSON-schema tools ------------
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "evg-gemini-check-"));
  fs.cpSync(sessionDir(), ws, { recursive: true, filter: (p) => !/\.git($|\/)/.test(p) });
  fs.writeFileSync(path.join(ws, "TASK.md"), "Tidy the screen.");
  fs.rmSync(path.join(ws, ".gemini-history.json"), { force: true });
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ url, body });
    const reply = (status, obj) => ({ ok: status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj });
    if (/\/models\?/.test(url)) {
      return reply(200, {
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
        ],
      });
    }
    if (/gemini-9-flash:/.test(url)) return reply(404, { error: { message: "models/gemini-9-flash is not found" } });
    if (body.tools[0].functionDeclarations[0].parametersJsonSchema) {
      return reply(400, { error: { message: 'Invalid JSON payload received. Unknown name "parametersJsonSchema"' } });
    }
    return reply(200, call("finish", { summary: "tidied" }));
  };
  const r = await geminiLoop({
    workspace: ws,
    onEvent: () => {},
    fetchImpl,
    env: { ...process.env, GEMINI_API_KEY: "k", EVG_GEMINI_MODEL: "gemini-9-flash", GEMINI_API_BASE: "http://x/v1beta" },
  });
  assert(r.ok && r.model === "gemini-3.5-flash", `fallback model: ${r.model}`);
  const last = seen.at(-1).body;
  assert(last.tools[0].functionDeclarations.find((d) => d.name === "apply_ops").parameters.properties.ops_json, "string tools after a 400");
  fs.rmSync(ws, { recursive: true, force: true });
  console.log("  fallbacks   an unserved model → the newest Flash; refused JSON-schema tools → string ops");
}

console.log("ALL PASS — Gemini adapter");

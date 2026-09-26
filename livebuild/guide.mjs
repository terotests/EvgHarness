/**
 * The part of the workspace guide every agent needs before anything else.
 *
 * The long AGENTS.md explains the engine, the app runtime and every finding
 * `measure` can report. Capable agents read it; a smaller model (Gemini
 * Flash) drowned in it and in the forty "do not" lines that grew around it.
 * This is the short version: what the goal is, what a document is, the five
 * ops, the loop, and the handful of rules that decide whether a screen comes
 * out as an application or as a drawing of one. AGENTS.md starts with it and
 * Gemini's system prompt is built from it.
 */

export const DEVICES = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
};

export function viewOf(task) {
  const m = /designed for an? (\w+), (\d+) x (\d+)/.exec(String(task || ""));
  if (m) return { name: m[1], width: Number(m[2]), height: Number(m[3]) };
  return { name: "phone", ...DEVICES.phone };
}

// `tools` names the verbs as this agent calls them: shell commands for a CLI
// agent, function names for Gemini.
// `caps` is what the linked Ranger can do (capabilities.mjs): the kit pieces
// it has, and whether a document's theme switches the kit's colours.
export function quickStart(view = { name: "phone", width: 390, height: 844 }, tools = SHELL_TOOLS, caps = null) {
  const { width: W, height: H, name } = view;
  const measure = tools.measure.replace(/\bW\b/, String(W)).replace(/\bH\b/, String(H));
  return `## What you are building

An application screen, written the way HTML and CSS are written: a tree of
\`div\` and \`span\` nodes laid out with flex and grid, styled by a stylesheet,
with an \`id\` on everything a person can press. It is ONE ${name} screen,
${W} × ${H}, in \`doc.evg.json\`. The live page repaints it after every
change, so build it in steps and check each one.

## The document

\`\`\`json
{"evg":1,
 "css":".card { background-color: #1e293b; border-radius: 14px; padding-top: 12px; padding-bottom: 12px; padding-left: 16px; padding-right: 16px; gap: 6px }",
 "root":{"tag":"div","props":{"width":"${W}px","height":"${H}px","display":"flex","flex-direction":"column","gap":"12px","padding-left":"16px","padding-right":"16px","background-color":"#0f172a"},
  "children":[
   {"tag":"span","text":"Orders","props":{"font-size":"22px","font-weight":"bold","color":"#f8fafc"}},
   {"tag":"div","id":"open.orders","props":{"class-name":"card"},"children":[
     {"tag":"span","text":"1,284","props":{"font-size":"26px","color":"#f8fafc"}},
     {"tag":"span","text":"this month","props":{"font-size":"12px","color":"#94a3b8"}}]}]}}
\`\`\`

- A node is \`{tag, id?, text?, props, children}\`. Text lives in a \`span\`
  with \`text\`; a \`div\` holds children. A node never has both.
- Props are CSS names with CSS values: \`"16px"\`, \`"50%"\`, \`"#0f172a"\`,
  \`"rgb(15,23,42)"\`, \`"bold"\`.
- A \`div\` is \`display: block\` and \`flex-direction: column\` until you say
  otherwise. Rows need \`"display":"flex","flex-direction":"row"\`.
- Addresses: \`0\` is the root, \`0/2\` its third child, \`0/2/0\` that child's
  first child. They shift when you insert or remove above them — re-read the
  outline after structural edits.

**Properties that exist:** width height min-width max-width min-height
max-height · display flex-direction justify-content align-items flex-wrap
flex-grow flex-shrink flex-basis gap · grid-template-columns
grid-template-rows grid-area grid-column grid-row grid-auto-flow ·
padding-top/right/bottom/left margin-top/right/bottom/left · position top
left right bottom · background-color background-gradient color opacity ·
border-width border-color border-radius · font-size font-weight font-family
line-height text-align white-space overflow · class-name.

**Not supported:** the shorthands \`padding\`, \`margin\`, \`border\`,
\`background\`, \`flex\`, and \`box-shadow\`, \`z-index\`, \`letter-spacing\`,
\`text-transform\`, \`text-decoration\`, \`font-style\`, \`align-self\`,
\`row-gap\`, \`box-sizing\`. Write the long forms; leave the rest out.

## The edits

${tools.patchIntro}

\`\`\`json
{"op":"set-prop","at":"0/1","prop":"background-color","value":"#1e293b"}
{"op":"set-text","at":"0/1/0","value":"Revenue"}
{"op":"set-id","at":"0/4/0","value":"nav.home"}
{"op":"set-css","value":".card { border-radius: 14px }\\n.muted { color: #94a3b8 }"}
{"op":"insert","at":"0","index":2,"node":{"tag":"div","props":{"class-name":"card"},"children":[{"tag":"span","text":"New"}]}}
{"op":"remove","at":"0/3"}
{"op":"move","at":"0/3","to":"0","index":0}
\`\`\`

- \`insert\` puts \`node\` (a whole subtree, document shape) into the parent
  \`at\`, before child number \`index\`. To add under an empty root, \`at\` is
  \`"0"\`.
- \`set-css\` replaces the whole stylesheet: send every rule each time.
  Class selectors, \`:hover\`, \`:active\`, \`:disabled\` and media queries
  work; \`#id\` selectors do not.
- \`id\` is not a property. Use \`set-id\`, or \`"id"\` on an inserted node.
- A batch is all or nothing: one bad op rejects it and nothing changes.

## Kit pieces: ask for them, do not draw them

${tools.kitIntro}

${pieceTable(caps)}

${themeNote(caps)}

Controls (switch, checkbox, slider, select, tabs, input, button, …) are in
the kit too: ${tools.kitList}. A switch drawn from a rounded box and a circle
looks right and does nothing; the kit's one works. What the kit does not
have, build from divs and spans — but never a fake control.

## The loop

1. ${tools.outline} — see what is there.
2. Build one section at a time: a kit piece, or an insert batch for one
   card. Structure first (containers, rows, text), then the stylesheet.
3. ${measure} — after every section. \`findings\` are defects (overlap,
   overflow, off the page); \`align\` lists rows that do not share an edge.
   Fix them before the next section.
4. Repeat until the screen has everything the task asked for.
5. ${tools.finish}

## Rules that decide the result

- Lay out, do not place. Columns are \`flex-direction: column\` + \`gap\`,
  rows are \`flex-direction: row\` + \`gap\` / \`justify-content\`, a 2-column
  block is \`display: grid\` + \`grid-template-columns: 1fr 1fr\`.
  \`position: absolute\` is only for what floats (a badge, a FAB). Never
  compute \`top\`/\`left\` for things in the flow.
- The root is exactly ${W}px × ${H}px. Content that does not fit scrolls
  in a child with \`overflow: scroll\`; it does not push past the page.
- Things that look alike share a class in the stylesheet: four cards are
  one \`.card\` rule, not four copies of six properties.
- Every pressable thing gets an \`id\`: tabs \`nav.<screen>\`, buttons and
  rows \`<verb>.<thing>\` (\`open.invoice\`, \`toggle.wifi\`). An app is made
  from these ids later; a nameless button can never be wired.
- Real words. Every label is text a person would read on this screen, with
  normal spacing — no lorem ipsum, no placeholders.
- Edit the document that is there. Start over only when the task says so.
`;
}


const PIECE_ROWS = [
  ["appbar", "| appbar | top bar: back, title, action | `--title \"Orders\"` |"],
  ["tabbar", "| tabbar | bottom nav | `--tab \"Home|⌂|nav.home\" --tab \"Search|⌕|nav.search\" --active nav.home` |"],
  ["card", "| card | a settings list of rows | `--title \"NETWORK\" --row \"Wi-Fi|Home-5G|switch:on\" --row \"Privacy||chevron\"` |"],
  ["row", "| row | one settings row | `--title \"Dark mode\" --control switch --id toggle.dark --bind dark` |"],
  ["tiles", "| tiles | 2×2 metric tiles | `--tile \"Revenue|$12.4k|+8% this week|$\"` (label|value|sub|icon) |"],
  ["bars", "| bars | trend card with a bar chart | `--title \"Orders\" --value \"1,284\" --badge \"+12%\" --bar \"M|55\" --bar \"T|80|#60a5fa\"` |"],
  ["banner", "| banner | highlight strip | `--eyebrow \"New\" --title \"Invoices are live\" --sub \"Send one today\"` |"],
  ["pills", "| pills | segmented Day/Week/Month | `--pill Day --pill Week --pill Month --active Week` |"],
  ["chips", "| chips | round actions | `--chip \"Share|↗|net.share\" --chip \"Forget|✕|net.forget\"` |"],
  ["actions", "| actions | row of buttons | `--button \"Pay now|primary|invoice.pay\" --button \"Later|secondary|invoice.later\"` |"],
  ["field", "| field | labelled text field | `--label \"Email\" --placeholder \"you@example.com\" --id field.email` |"],
];

function pieceTable(caps) {
  const have = caps && Array.isArray(caps.pieces) && caps.pieces.length ? new Set(caps.pieces) : null;
  const rows = PIECE_ROWS.filter(([name]) => !have || have.has(name)).map(([, row]) => row);
  return ["| piece | what it is | example flags |", "| --- | --- | --- |", ...rows].join("\n");
}

function themeNote(caps) {
  if (!caps || caps.theme) {
    return `The pieces are light by default. On a dark screen, set the root's theme —
\`{"op":"set-prop","at":"0","prop":"theme","value":"dark"}\` — and the kit's
\`.theme-dark\` rules restyle every piece. Scope your own rules the same way
(\`.theme-dark .card { … }\`); a descendant selector works only as
\`.theme-<name> .class\`.`;
  }
  return `The pieces are light by default: dark text on white. This Ranger checkout
ignores a document's \`theme\`, so \`theme: dark\` changes nothing. On a dark
screen, restyle the pieces in the stylesheet: their parts have classes
(\`.ui-row-title\`, \`.ui-appbar-title\`, \`.ui-card\` — kit_spec / \`./evg-ui spec\`
lists them), so \`.ui-row-title { color: #f8fafc }\` is the whole job. Text you
cannot read on its background is the first thing to check.`;
}

export const SHELL_TOOLS = {
  patchIntro:
    "Write ops to a file and apply them with `./evg-agent patch doc.evg.json ops.json`. The file is `{\"ops\":[ … ]}`; the answer carries `layout` (the same numbers as measure).",
  kitIntro:
    "`./evg-ui add <piece> [flags] --into doc.evg.json > add.json` writes a batch that inserts a finished, styled piece (with `--at PATH --index N` to choose where); `./evg-agent patch doc.evg.json add.json` applies it. `./evg-ui spec <piece>` lists its flags.",
  kitList: "`./evg-ui list`",
  outline: "`./evg-agent outline doc.evg.json`",
  measure: "`./evg-agent measure doc.evg.json --width=W --height=H`",
  finish: "Stop when the outline shows every part of the ask and measure has no findings. Say in one or two sentences what you built.",
};

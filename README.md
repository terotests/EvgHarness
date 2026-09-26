# EvgHarness

A local harness where an AI agent builds an **HTML-like EVG application
screen** while you watch: the agent edits an EVG document (flex/grid layout,
a stylesheet, kit controls, ids on everything pressable), and the page
repaints it after every edit, streamed from the [Ranger](https://github.com/terotests/Ranger)
EVG engine as display lists.

The agent can be:

| agent | needs |
| --- | --- |
| **Gemini** (Flash, over the API) | `GEMINI_API_KEY` or `GOOGLE_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey) |
| **Cursor** (Agent CLI) | `curl https://cursor.com/install -fsS \| bash`, then `agent login` (or `CURSOR_API_KEY`) |
| **Claude Code** (CLI) | `claude` on `PATH`, logged in |
| Codex, Ollama | `codex` on `PATH` / Ollama on `:11434` |
| recipe | nothing: a scripted restyle, no model |

A screenshot attached to the ask is read by
[Erazer](https://github.com/terotests/Erazer) into a widget outline (with
[Tesseract](https://github.com/tesseract-ocr/tesseract) for the labels, if
installed), so "build a screen like this" starts from the picture's
structure, colours and words.

## Run it

Node 20 or newer, and git.

```sh
git clone https://github.com/terotests/EvgHarness
cd EvgHarness
export GEMINI_API_KEY=…        # optional: any one agent is enough
npm start
# open http://127.0.0.1:8765
```

The first `npm start` clones Ranger and Erazer into `.deps/` and compiles the
tools it needs (about half a minute). Later starts reuse them. Without
`--agent`, it picks the first agent it finds: Gemini, then Cursor, then
Claude, then the recipe. The page's agent row switches between all of them.

```sh
npm run start:gemini           # or start:cursor, start:claude, start:recipe
npm start -- --port=9000
npm run setup -- --update      # pull newer Ranger / Erazer into .deps
npm run setup -- --rebuild     # recompile every tool
```

Optional, for screenshots: `brew install tesseract` / `apt install
tesseract-ocr`, or `TESSERACT_PATH`.

### Using your own checkouts

```sh
RANGER_DIR=~/src/Ranger ERAZER_DIR=~/src/Erazer npm start
```

The harness links itself into the Ranger checkout at `gallery/evg/livebuild`
and Erazer at `gallery/erazer`. Its Ranger sources import `pkg:evg` relative
to that place and are compiled by Ranger's own compiler. Ranger ignores both
paths. If either path is a real directory in your checkout, setup stops and
says so rather than touching it.

`RANGER_REF` / `ERAZER_REF` choose the branch cloned into `.deps/`
(defaults in `harness.config.json`).

## Using the page

- The page opens on a finished phone dashboard. Type what you want and press
  **Follow up**: the agent edits that screen, and you see its thinking, the
  ops it applied, and the screen repainting.
- **Start over** chips (Dashboard, Settings, Invoices, Empty) swap the seed;
  **Reset** empties it.
- **Phone / Tablet / Desktop** set the size the agent designs for.
- **Picture** attaches a screenshot to the next ask.
- **Run** turns the screen into an app: tabs with `nav.<state>` ids become
  states, and a press moves between them.
- **Save / Saved…** keep designs under `~/.evg-livebuild/saved/`, **Export**
  copies one `.ranger.json` (ui tree, CSS, state machine).

## What an agent is given

Every task runs in a session workspace (`$TMPDIR/evg-live-session`):

| | |
| --- | --- |
| `doc.evg.json` | the screen |
| `TASK.md` | the ask, the device size, the current outline |
| `AGENTS.md` | the guide: a short quick start (the goal, the document format, the ops, the kit, the loop, the rules), then the reference |
| `./evg-agent` | `outline`, `patch`, `measure`, `pick`, `query` |
| `./evg-ui` | kit pieces and controls: `add tiles …`, `add tabbar …`, `spec <name>` |
| `./evg-app` | multi-screen apps: `init`, `check`, `press`, `render` |
| `attachment.*` | the attached picture, its palette, and `attachment.erazer.txt` |

The CLI agents read `AGENTS.md` and use the shell tools. Gemini gets the same
quick start as its system prompt and typed function tools; see
[livebuild/README.md](livebuild/README.md#how-gemini-is-driven) for how that
loop works and its settings.

## Checks

```sh
npm run check        # recipes, orchestrator, Gemini (loopback, no key), stream, apps, export, save
npm run check:web    # + Chromium: the page, and the GPU effects painter (npm install first)
```

`check:web` needs `npm install` (for `playwright-core`) and a Chromium:
`CHROME_PATH`, or the one Playwright installed.

## Layout

| | |
| --- | --- |
| `scripts/` | `setup`, `start`, `check`: dependencies, links, builds, agent choice |
| `harness.config.json` | where Ranger and Erazer are cloned from |
| `livebuild/` | the harness itself: server, page, orchestrator, agents, guide, checks, fixtures — [README](livebuild/README.md) |

## License

AGPL-3.0-or-later (`LICENSE`), like the Ranger gallery it came from.

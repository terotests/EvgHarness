/**
 * Where the Ranger checkout is.
 *
 * The harness lives in its own repository (EvgHarness) and is linked into a
 * Ranger checkout at `gallery/evg/livebuild`, because the Ranger sources here
 * (`EvgAppKit.rgr`, …) import `pkg:evg` and are compiled by Ranger's
 * `dist/rgrc.js`. Node resolves the symlink, so `here` is the harness folder
 * and `../../..` is not Ranger. The order:
 *
 *   1. RANGER_ROOT (set by `npm start`)
 *   2. the current directory, when it is a Ranger checkout linked to this
 *      harness — running a check from inside the checkout means that one
 *   3. ../../.. when this folder really sits inside a Ranger checkout
 *   4. ../.deps/Ranger, where `npm run setup` clones it
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const harnessDir = path.dirname(fileURLToPath(import.meta.url));

function isRanger(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, "dist", "rgrc.js")) && fs.existsSync(path.join(dir, "lib", "evg"));
}

function findRoot() {
  const fromEnv = process.env.RANGER_ROOT ? path.resolve(process.env.RANGER_ROOT) : "";
  if (fromEnv) return fromEnv;
  const cwd = process.cwd();
  try {
    if (isRanger(cwd) && fs.realpathSync(path.join(cwd, "gallery/evg/livebuild")) === fs.realpathSync(harnessDir)) return cwd;
  } catch {
    /* not linked here */
  }
  const inTree = path.resolve(harnessDir, "../../..");
  if (isRanger(inTree)) return inTree;
  const deps = path.resolve(harnessDir, "../.deps/Ranger");
  if (isRanger(deps)) return deps;
  throw new Error(
    "Ranger checkout not found. Run `npm run setup` in EvgHarness, or set RANGER_ROOT to a Ranger checkout.",
  );
}

export const root = findRoot();
// Children (the agent processes, the workspace shims) run in other
// directories; they inherit the answer rather than guessing again.
process.env.RANGER_ROOT = root;

// The harness as the Ranger compiler must see it: through the link. A
// `ranger.json` under it (fixtures/codeapp) names `lib/evg` relatively, and
// that only resolves from gallery/evg/livebuild.
export const liveDir = path.join(root, "gallery", "evg", "livebuild");

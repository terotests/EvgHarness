/**
 * The frame's view of a document: what one screen shows, not what the file
 * says. Used by the orchestrator's frames and by Gemini's measure, so both
 * see the same picture.
 */

// A BOUND CONTROL, DRAWN AS IT WAS ASKED FOR.
//
// A switch added with `--bind live` carries `ui-switch-state-{live}`: the app
// fills `{live}` from its context on every render. On one screen there is no
// context, so neither the checked nor the unchecked rule matched and the
// switch drew in its base style whatever it was drawn as — which an agent
// then "fixed" by painting the base class green, and the switch showed "on"
// for good. The frame is a VIEW: a copy where each `{key}` under a control
// reads the state the control was drawn in (its `checked`). The document
// keeps the binding.
export function designView(docText) {
  let doc;
  try {
    doc = JSON.parse(docText);
  } catch {
    return null;
  }
  let changed = false;
  const walk = (n, state) => {
    if (!n || typeof n !== "object") return;
    let here = state;
    // `checked` is the accessibility tri-state: 1 is off, 2 is on.
    if (n.checked !== undefined) here = n.checked === 2 || n.checked === true || n.checked === "true" ? "checked" : "unchecked";
    const props = n.props || {};
    const cls = String(props["class-name"] || "");
    if (here && /\{[\w.-]+\}/.test(cls)) {
      props["class-name"] = cls.replace(/\{[\w.-]+\}/g, here);
      changed = true;
    }
    for (const c of n.children || []) walk(c, here);
  };
  walk(doc.root, "");
  return changed ? JSON.stringify(doc) : null;
}

// Service Dark: lock a form's fields while it waits, without moving focus.
// Plain JS, no dependencies. Works as a Svelte action (use:busy={wait.busy})
// or by hand: const b = busy(formEl, true); b.update(false);
//
// Disabling fields would throw focus to the top of the page, so instead this marks the element
// aria-busy, adds sd-busy (which stops pointer input on fields in the stylesheet) and ignores typing,
// pasting and dropping. Tab, Shift+Tab and Escape still work, so people can move and leave.
// Keys on buttons pass, because each kit Button blocks itself and a Cancel may stay usable.

const PASS = new Set(["Tab", "Escape", "Shift", "Control", "Alt", "Meta"]);

export function busy(node, on = false) {
  let active = on;

  const stop = (e) => {
    if (!active) return;
    // Buttons decide for themselves (a Cancel may still work), so keys on them pass.
    if (e.type === "keydown" && (PASS.has(e.key) || e.target.closest?.("button"))) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const events = ["keydown", "beforeinput", "paste", "drop", "cut"];
  for (const t of events) node.addEventListener(t, stop, true);

  function sync() {
    node.classList.toggle("sd-busy", active);
    if (active) node.setAttribute("aria-busy", "true");
    else node.removeAttribute("aria-busy");
  }
  sync();

  return {
    update(next) { active = next; sync(); },
    destroy() {
      for (const t of events) node.removeEventListener(t, stop, true);
      node.classList.remove("sd-busy");
      node.removeAttribute("aria-busy");
    }
  };
}

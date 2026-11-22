// Service Dark: one box per character for pairing and one-time codes.
// Plain JS, no dependencies. Works as a Svelte action (use:codeInput={options})
// or by hand on any element that contains the code's <input> boxes, in order.
//
// options:
//   oninput     called with the current value (a string) on every change
//   oncomplete  called with the value once every box is filled
//   allowed     RegExp for one allowed character (default: A-Z and 2-9 without O and I)

const DEFAULT_ALLOWED = /[A-HJ-NP-Z2-9]/;

export function codeInput(group, options = {}) {
  let o = options;
  const boxes = () => Array.from(group.querySelectorAll("input"));
  const allowed = () => o.allowed ?? DEFAULT_ALLOWED;
  const clean = (s) => s.toUpperCase().split("").filter((c) => allowed().test(c));
  const value = () => boxes().map((b) => b.value).join("");
  const focus = (i) => { const b = boxes(); b[Math.max(0, Math.min(b.length - 1, i))]?.focus(); };

  function emit() {
    const v = value();
    o.oninput?.(v);
    if (v.length === boxes().length) o.oncomplete?.(v);
  }

  function fill(from, chars) {
    const b = boxes();
    let i = from;
    for (const c of chars) { if (i >= b.length) break; b[i++].value = c; }
    emit();
    focus(i);
  }

  function onInput(e) {
    const box = e.target, b = boxes(), i = b.indexOf(box);
    if (i < 0) return;
    const prev = box.dataset.prev ?? "";
    let chars = clean(box.value);
    if (chars.length > 1 && chars[0] === prev) chars = chars.slice(1);
    box.value = "";
    if (!chars.length) { emit(); return; }
    fill(i, chars);
  }

  function onKeyDown(e) {
    const b = boxes(), i = b.indexOf(e.target);
    if (i < 0) return;
    if (e.key === "Backspace") {
      e.preventDefault();
      if (b[i].value) b[i].value = "";
      else if (i > 0) { b[i - 1].value = ""; focus(i - 1); }
      emit();
    } else if (e.key === "ArrowLeft") { e.preventDefault(); focus(i - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); focus(i + 1); }
  }

  function onPaste(e) {
    const i = boxes().indexOf(e.target);
    if (i < 0) return;
    e.preventDefault();
    fill(i, clean(e.clipboardData?.getData("text") ?? ""));
  }

  function onFocusIn(e) {
    if (e.target.tagName !== "INPUT") return;
    e.target.dataset.prev = e.target.value;
    e.target.select();
  }

  group.addEventListener("input", onInput);
  group.addEventListener("keydown", onKeyDown);
  group.addEventListener("paste", onPaste);
  group.addEventListener("focusin", onFocusIn);

  return {
    update(next) { o = next; },
    destroy() {
      group.removeEventListener("input", onInput);
      group.removeEventListener("keydown", onKeyDown);
      group.removeEventListener("paste", onPaste);
      group.removeEventListener("focusin", onFocusIn);
    }
  };
}

// Service Dark: copy a value to the clipboard on click.
// Plain JS, no dependencies. Works as a Svelte action (use:copy={{ text, oncopied }})
// or by hand: copy(buttonEl, { text: "svc_live_..." }).
//
// Sets data-copied on the element for 1.4s so CSS or the caller can show "Copied".

export function copy(node, options = {}) {
  let o = typeof options === "string" ? { text: options } : options;
  let timer;

  async function onClick() {
    const text = typeof o.text === "function" ? o.text() : String(o.text ?? "");
    try { await navigator.clipboard.writeText(text); } catch { return; }
    node.dataset.copied = "true";
    o.oncopied?.(true);
    clearTimeout(timer);
    timer = setTimeout(() => { delete node.dataset.copied; o.oncopied?.(false); }, 1400);
  }

  node.addEventListener("click", onClick);
  return {
    update(next) { o = typeof next === "string" ? { text: next } : next; },
    destroy() { clearTimeout(timer); node.removeEventListener("click", onClick); }
  };
}

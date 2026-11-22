// Service Dark: open and close a native <dialog> from state.
// Plain JS, no dependencies. Works as a Svelte action (use:modal={{ open, onclose }})
// or by hand: const m = modal(dialogEl, { open: true, onclose }); m.update({ open: false, onclose });
//
// The browser's <dialog> gives the focus trap, top layer and backdrop.
// Escape and a click on the backdrop call onclose instead of closing directly,
// so the caller's state stays the single source of truth.

export function modal(dialog, options = {}) {
  let o = options;

  function sync() {
    if (o.open && !dialog.open) dialog.showModal();
    else if (!o.open && dialog.open) dialog.close();
  }

  function onCancel(e) { e.preventDefault(); o.onclose?.(); }
  function onClick(e) {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) o.onclose?.();
  }

  dialog.addEventListener("cancel", onCancel);
  dialog.addEventListener("click", onClick);
  sync();

  return {
    update(next) { o = next; sync(); },
    destroy() {
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onClick);
      if (dialog.open) dialog.close();
    }
  };
}

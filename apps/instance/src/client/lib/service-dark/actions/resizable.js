// Service Dark: resizable sidebar.
// Plain JS, no dependencies. Works as a Svelte action (use:resizable={options})
// or by hand: const r = resizable(handleEl, options); r.update(next); r.destroy();
//
// handle: the element the person drags, placed on the panel's right edge.
// options:
//   target        element to resize (default: handle.parentElement)
//   defaultWidth  width on first visit and after reset (default 240)
//   min           narrowest width, the icon rail (default 56)
//   max           widest width (default: viewport width minus 48)
//   width         current width when the caller owns it (a cookie value, say)
//   storageKey    localStorage key that remembers the width
//   compactBelow  width under which compactClass is set (default 136)
//   compactClass  class toggled on target in the rail (default "sd-sidebar-compact")
//   onresize      called with the new width on every change

function read(key) {
  try { const v = key ? localStorage.getItem(key) : null; return v ? parseInt(v, 10) || null : null; } catch { return null; }
}
function save(key, w) {
  try { if (key) localStorage.setItem(key, String(w)); } catch { /* storage blocked: width just isn't remembered */ }
}

export function resizable(handle, options = {}) {
  let o = options;
  const target = () => o.target || handle.parentElement;
  const min = () => o.min ?? 56;
  const def = () => o.defaultWidth ?? 240;
  const max = () => Math.max(min(), Math.min(o.max ?? Infinity, window.innerWidth - 48));
  const clamp = (w) => Math.round(Math.max(min(), Math.min(max(), w)));

  let width = clamp(o.width ?? read(o.storageKey) ?? def());

  function apply(w, persist) {
    width = clamp(w);
    const t = target();
    t.style.width = width + "px";
    t.classList.toggle(o.compactClass ?? "sd-sidebar-compact", width < (o.compactBelow ?? 136));
    handle.setAttribute("aria-valuenow", String(width));
    handle.setAttribute("aria-valuemin", String(min()));
    handle.setAttribute("aria-valuemax", String(Math.round(max())));
    if (persist) save(o.storageKey, width);
    o.onresize?.(width);
  }

  handle.classList.add("sd-resize");
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  if (!handle.hasAttribute("aria-label")) handle.setAttribute("aria-label", "Resize sidebar");
  if (!handle.hasAttribute("title")) handle.setAttribute("title", "Drag to resize. Double-click to reset.");
  handle.tabIndex = 0;

  function onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = target().getBoundingClientRect().width;
    handle.setPointerCapture?.(e.pointerId);
    handle.dataset.dragging = "true";
    document.body.classList.add("sd-resizing");
    const move = (ev) => apply(w0 + ev.clientX - x0, false);
    const up = () => {
      delete handle.dataset.dragging;
      document.body.classList.remove("sd-resizing");
      save(o.storageKey, width);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  function onKeyDown(e) {
    const step = e.shiftKey ? 64 : 16;
    const keys = { ArrowLeft: width - step, ArrowRight: width + step, Home: min(), End: max(), Enter: def() };
    if (!(e.key in keys)) return;
    e.preventDefault();
    apply(keys[e.key], true);
  }

  const onDblClick = () => apply(def(), true);
  const onWindowResize = () => apply(width, false);

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("keydown", onKeyDown);
  handle.addEventListener("dblclick", onDblClick);
  window.addEventListener("resize", onWindowResize);
  apply(width, false);

  return {
    update(next) {
      o = next;
      if (next.width != null && next.width !== width) apply(next.width, false);
    },
    destroy() {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("keydown", onKeyDown);
      handle.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("resize", onWindowResize);
    }
  };
}

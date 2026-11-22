// Service Dark: reorder a list by dragging a handle, or from the keyboard. Plain JS, no dependencies.
// Works as a Svelte action (use:sortable={options}) or by hand: const s = sortable(listEl, options).
//
// The list keeps owning its order: this never moves DOM nodes. It reports moves and the list re-renders,
// so it works with Svelte's keyed {#each}, React, or plain code that re-renders the items.
//
// Markup: each item has data-sort-item and data-sort-id="<unique id>", and holds a button with
// data-sort-handle. Only the handle starts a drag, so the rest of the row stays clickable.
//
// Pointer: press the handle and drag; the row follows the pointer and the others make room. Escape
// while dragging puts it back.
// Keyboard: focus the handle, Space or Enter picks the row up, arrows move it, Space or Enter drops it,
// Escape puts it back, Home and End jump to the ends. Focus stays on the handle throughout.
//
// Options:
//   onmove(from, to)   move the item at index from to index to now, as a preview; called while dragging
//   ondrop(from, to)   the drag ended: the item that started at from now sits at to (equal if it did not move)
//   oncancel(from)     the drag was abandoned: put the item back at from
//   announce(text)     optional: say each step to screen readers
//   name(index)        optional: what to call the item at index in announcements, such as its label
//   disabled           optional: ignore drags

const KEYS = new Set([" ", "Enter", "ArrowUp", "ArrowDown", "Home", "End", "Escape"]);

export function sortable(node, options = {}) {
  let opts = options;
  let drag = null;

  const items = () => [...node.querySelectorAll("[data-sort-item]")];
  const indexOf = (id) => items().findIndex((el) => el.dataset.sortId === id);
  const itemOf = (id) => items().find((el) => el.dataset.sortId === id);
  const say = (text) => opts.announce?.(text);
  const nameAt = (i) => opts.name?.(i) ?? `Item ${i + 1}`;
  const position = (i) => `${i + 1} of ${items().length}`;

  function refocus(id) {
    requestAnimationFrame(() => itemOf(id)?.querySelector("[data-sort-handle]")?.focus());
  }

  function move(to) {
    const from = indexOf(drag.id);
    const last = items().length - 1;
    const target = Math.max(0, Math.min(last, to));
    if (target === from) return from;
    opts.onmove?.(from, target);
    return target;
  }

  function finish(cancelled) {
    const { id, start, keyboard } = drag;
    const el = itemOf(id);
    el?.classList.remove("sd-sort-dragging");
    el?.style.removeProperty("transform");
    node.classList.remove("sd-sort-active");
    drag = null;
    if (cancelled) {
      const now = indexOf(id);
      if (now !== start) opts.onmove?.(now, start);
      opts.oncancel?.(start);
      say(`${nameAt(start)} put back at position ${position(start)}.`);
    } else {
      const end = indexOf(id);
      opts.ondrop?.(start, end);
      say(end === start ? `${nameAt(end)} dropped where it was.` : `${nameAt(end)} dropped at position ${position(end)}.`);
    }
    if (keyboard) refocus(id);
  }

  // ---- Keyboard --------------------------------------------------------------------------

  function onkeydown(e) {
    const handle = e.target.closest?.("[data-sort-handle]");
    if (!handle || opts.disabled || !KEYS.has(e.key)) return;
    const id = handle.closest("[data-sort-item]")?.dataset.sortId;
    if (id == null) return;
    if (!drag) {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      const start = indexOf(id);
      drag = { id, start, keyboard: true };
      itemOf(id)?.classList.add("sd-sort-dragging");
      node.classList.add("sd-sort-active");
      say(`${nameAt(start)} picked up at position ${position(start)}. Use the arrow keys to move it, Space to drop it, Escape to cancel.`);
      return;
    }
    if (!drag.keyboard) return;
    e.preventDefault();
    if (e.key === " " || e.key === "Enter") return finish(false);
    if (e.key === "Escape") return finish(true);
    const from = indexOf(id);
    const to = e.key === "ArrowUp" ? from - 1 : e.key === "ArrowDown" ? from + 1 : e.key === "Home" ? 0 : items().length - 1;
    const at = move(to);
    if (at !== from) say(`Position ${position(at)}.`);
    refocus(id);
  }

  function onfocusout() {
    // Leaving the list while a keyboard drag is open drops the row where it is. Moving a row re-renders
    // it, which blurs the handle for a moment, so check only after the handle has had time to refocus.
    if (!drag?.keyboard) return;
    setTimeout(() => {
      if (drag?.keyboard && !node.contains(document.activeElement)) finish(false);
    }, 50);
  }

  // ---- Pointer -----------------------------------------------------------------------------

  function onpointerdown(e) {
    const handle = e.target.closest?.("[data-sort-handle]");
    if (!handle || opts.disabled || e.button !== 0 || drag) return;
    const el = handle.closest("[data-sort-item]");
    const id = el?.dataset.sortId;
    if (id == null) return;
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);
    const start = indexOf(id);
    // Snapshot the layout once: where every other row's middle would sit with this row taken out.
    // Targets come from this snapshot, so re-renders during the drag never make the row jitter.
    const all = items();
    const stride = all.length > 1 ? Math.abs((all[start + 1] ?? all[start - 1]).offsetTop - el.offsetTop) : el.offsetHeight;
    const slots = all.filter((x) => x !== el).map((x, i) => x.offsetTop + x.offsetHeight / 2 - (i >= start ? stride : 0));
    drag = { id, start, keyboard: false, startY: e.clientY, startTop: el.offsetTop, height: el.offsetHeight, slots, handle };
    el.classList.add("sd-sort-dragging");
    node.classList.add("sd-sort-active");
    say(`${nameAt(start)} picked up.`);
    handle.addEventListener("pointermove", onpointermove);
    handle.addEventListener("pointerup", onpointerup);
    handle.addEventListener("pointercancel", onpointercancel);
  }

  function onpointermove(e) {
    if (!drag || drag.keyboard) return;
    const top = drag.startTop + (e.clientY - drag.startY);
    const middle = top + drag.height / 2;
    move(drag.slots.filter((m) => m < middle).length);
    // After the list re-renders, keep the row under the pointer.
    requestAnimationFrame(() => {
      const now = drag && itemOf(drag.id);
      if (now) now.style.transform = `translateY(${top - now.offsetTop}px)`;
    });
  }

  function endPointer(cancelled) {
    const { handle } = drag;
    handle.removeEventListener("pointermove", onpointermove);
    handle.removeEventListener("pointerup", onpointerup);
    handle.removeEventListener("pointercancel", onpointercancel);
    finish(cancelled);
  }

  const onpointerup = () => drag && !drag.keyboard && endPointer(false);
  const onpointercancel = () => drag && !drag.keyboard && endPointer(true);

  function onwindowkey(e) {
    if (e.key === "Escape" && drag && !drag.keyboard) {
      e.preventDefault();
      endPointer(true);
    }
  }

  node.addEventListener("keydown", onkeydown);
  node.addEventListener("focusout", onfocusout);
  node.addEventListener("pointerdown", onpointerdown);
  window.addEventListener("keydown", onwindowkey);

  return {
    update(next) { opts = next; },
    destroy() {
      if (drag && !drag.keyboard) endPointer(true);
      node.removeEventListener("keydown", onkeydown);
      node.removeEventListener("focusout", onfocusout);
      node.removeEventListener("pointerdown", onpointerdown);
      window.removeEventListener("keydown", onwindowkey);
    }
  };
}

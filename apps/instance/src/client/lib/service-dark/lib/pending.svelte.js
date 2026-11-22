// Service Dark: how the kit waits. Every component that can wait on the app uses this file,
// so blocking, spinners, errors, retries and announcements behave the same everywhere.
//
// The one rule for apps: a handler that waits returns its promise.
//   onclick={() => save()}            the kit waits for save()
//   onclick={() => { save(); }}       the kit cannot see save(), so nothing is blocked
// The promise resolves to nothing on success, or to one sentence that says what went wrong.
// A handler that returns no promise is treated as done at once, whatever it returns.
// Resolving to false means "not done, nothing to add", such as when fields failed their schema.
// A thrown error shows messages.failed and is logged.
//
// Handlers receive { signal, key }:
//   signal  an AbortSignal; pass it to fetch so Cancel can stop waiting
//   key     an idempotency key; send it so the server can ignore a repeated request.
//           It is kept for a retry after a thrown error (the outcome is unknown), and renewed after an answer.

import { getContext, setContext } from "svelte";

/** Every delay the kit uses, in milliseconds. Tune them here and only here. */
export const timing = {
  /** A spinner shows only once a wait passes this, so fast actions never flicker. */
  spinnerAfter: 400,
  /** Once shown, a spinner stays at least this long. */
  spinnerAtLeast: 300,
  /** After this, the wait reads "Still working". */
  slowAfter: 10000,
  /** Typed settings save once typing pauses this long, or on blur. */
  debounce: 500
};

/** The only words the kit says while waiting. */
export const messages = {
  working: "Working",
  slow: "Still working",
  saved: "Saved",
  checking: "Checking the code",
  failed: "That didn't work. Try again."
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isThenable = (v) => v != null && typeof v.then === "function";
// randomUUID needs a secure context (https or localhost); getRandomValues works everywhere.
const newKey = () => globalThis.crypto?.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

// ---- Announcer: one polite live region for the whole page --------------------------------

let region;
/** Say a short message to screen readers. The same message twice is said twice. */
export function announce(text) {
  if (typeof document === "undefined" || !text) return;
  if (!region || !region.isConnected) {
    region = document.createElement("div");
    region.className = "sd-sr";
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    region.dataset.sdAnnouncer = "";
    document.body.append(region);
  }
  region.textContent = "";
  setTimeout(() => (region.textContent = text), 30);
}

// ---- Dev warning: a handler that started a request but did not return it ----------------

const dev = () => globalThis.__SERVICE_DARK_DEV__ ?? import.meta.env?.DEV === true;
let watch = { until: 0, name: "", inside: false, saw: false };
let fetchWatched = false;

function watchFetch() {
  if (fetchWatched || typeof globalThis.fetch !== "function") return;
  fetchWatched = true;
  const original = globalThis.fetch;
  globalThis.fetch = function (...args) {
    if (watch.inside) watch.saw = true;
    else if (performance.now() < watch.until) warnUnreturned(watch.name);
    return original.apply(this, args);
  };
}

function warnUnreturned(name) {
  watch.until = 0;
  console.warn(`Service Dark: ${name} started a request but its handler returned nothing, so nothing waited for it. Return the promise: () => save(), not () => { save(); }.`);
}

function call(fn, arg, name) {
  if (!dev()) return fn(arg);
  watchFetch();
  watch.inside = true;
  watch.saw = false;
  let result;
  try {
    result = fn(arg);
  } finally {
    watch.inside = false;
  }
  if (!isThenable(result)) {
    if (watch.saw) warnUnreturned(name);
    else watch = { until: performance.now() + 50, name, inside: false, saw: false };
  }
  return result;
}

// ---- Pending: one wait at a time ---------------------------------------------------------

export class Pending {
  /** True from the moment the wait starts: block repeats and edits. */
  busy = $state(false);
  /** True once the wait passes timing.spinnerAfter: show the spinner. */
  spinning = $state(false);
  /** True once the wait passes timing.slowAfter: say "Still working". */
  slow = $state(false);
  /** The sentence from the last failed wait, until the next one starts. */
  error = $state("");

  #controller = null;
  #key = null;

  /**
   * @param {object} [options]
   * @param {string} [options.name] Names the component in dev warnings.
   * @param {boolean} [options.abortable] Cancel and Escape may stop the wait instead of being blocked.
   * @param {boolean} [options.speak] Announce "Working", "Still working" and errors. Default true.
   */
  constructor({ name = "A Service Dark handler", abortable = false, speak = true } = {}) {
    this.name = name;
    this.abortable = abortable;
    this.speak = speak;
  }

  /**
   * Run fn once; a call while busy is ignored.
   * @param {(wait: { signal: AbortSignal, key: string }) => unknown} fn
   * @returns {Promise<{ ok: boolean, error?: string, aborted?: boolean, skipped?: boolean, value?: unknown }>}
   */
  async run(fn) {
    if (this.busy) return { ok: false, skipped: true };
    this.busy = true;
    this.error = "";
    const controller = new AbortController();
    this.#controller = controller;
    const key = (this.#key ??= newKey());
    let shownAt = 0;
    const spin = setTimeout(() => {
      this.spinning = true;
      shownAt = performance.now();
      if (this.speak) announce(messages.working);
    }, timing.spinnerAfter);
    const slow = setTimeout(() => {
      this.slow = true;
      if (this.speak) announce(messages.slow);
    }, timing.slowAfter);

    let outcome;
    let unknown = false;
    try {
      const returned = call(fn, { signal: controller.signal, key }, this.name);
      // Only a returned promise reports an error, so () => (label = "Copied") is never mistaken for one.
      outcome = isThenable(returned) ? await returned : undefined;
    } catch (e) {
      if (!controller.signal.aborted) {
        unknown = true;
        console.error(e);
        outcome = messages.failed;
      }
    }
    clearTimeout(spin);
    clearTimeout(slow);
    if (shownAt) {
      const left = timing.spinnerAtLeast - (performance.now() - shownAt);
      if (left > 0) await sleep(left);
    }
    this.busy = false;
    this.spinning = false;
    this.slow = false;
    this.#controller = null;
    if (!unknown) this.#key = null;

    if (controller.signal.aborted) return { ok: false, aborted: true };
    if (outcome === false) return { ok: false };
    if (typeof outcome === "string" && outcome) {
      this.error = outcome;
      if (this.speak) announce(outcome);
      return { ok: false, error: outcome };
    }
    return { ok: true, value: outcome };
  }

  /** Stop waiting: the signal aborts, and the result is ignored. The server may still finish the request. */
  abort() {
    this.#controller?.abort();
  }

  /**
   * For SvelteKit forms: <form method="POST" use:enhance={wait.enhance()} use:busy={wait.busy}>.
   * A failure's `message` (from fail(400, { message })) becomes the error.
   * @param {{ reset?: boolean, invalidateAll?: boolean }} [options] passed to update()
   */
  enhance(options) {
    return ({ cancel, controller }) => {
      if (this.busy) return cancel();
      let finish;
      const answered = new Promise((r) => (finish = r));
      this.run(({ signal }) => {
        signal.addEventListener("abort", () => controller.abort());
        return answered;
      });
      return async ({ result, update }) => {
        await update(options);
        if (result.type === "failure") finish(typeof result.data?.message === "string" ? result.data.message : messages.failed);
        else if (result.type === "error") finish(messages.failed);
        else finish();
      };
    };
  }
}

// ---- Latest: autosave without out-of-order writes ------------------------------------------

/**
 * Sends one value at a time and drops any value overtaken while it waited, so the last thing typed
 * is the last thing written. Every send carries `seq`, which only grows; the server keeps the highest
 * seq per path and ignores older ones, which also covers a second tab.
 */
export class Latest {
  pending;
  #next = null;

  /** @param {(result: Awaited<ReturnType<Pending["run"]>>) => void} onsettle called only for the latest send */
  constructor(onsettle, name) {
    this.pending = new Pending({ name, speak: false });
    this.onsettle = onsettle;
  }

  /** @param {(wait: { signal: AbortSignal, key: string, seq: number }) => unknown} fn */
  send(fn) {
    const seq = nextSeq();
    if (this.pending.busy) this.#next = { fn, seq };
    else this.#go({ fn, seq });
  }

  async #go({ fn, seq }) {
    const result = await this.pending.run((wait) => fn({ ...wait, seq }));
    const next = this.#next;
    this.#next = null;
    if (next) this.#go(next);
    else this.onsettle?.(result);
  }
}

let lastSeq = 0;
/** A number that grows across sends and page loads. */
export function nextSeq() {
  lastSeq = Math.max(lastSeq + 1, Math.floor((performance.timeOrigin + performance.now()) * 1000));
  return lastSeq;
}

// ---- Context: buttons inside a waiting form or dialog ------------------------------------

const KEY = Symbol("sd-pending");

/** Make a Pending that every kit Button below this component follows. Call during component setup. */
export function usePending(options) {
  const p = new Pending(options);
  setContext(KEY, p);
  return p;
}

/** Share an existing Pending with the kit Buttons below this component. */
export function providePending(p) {
  setContext(KEY, p);
  return p;
}

/** The Pending of the surrounding form or dialog, if any. */
export function pendingContext() {
  return getContext(KEY);
}

/**
 * How a kit button handles a click.
 *   submit  a type="submit" button follows the surrounding Pending and starts nothing itself
 *   cancel  stays usable while the surrounding Pending waits, if it is abortable, and stops the wait
 */
export function clickWait(e, { own, form, submit, cancel, onclick }) {
  if (submit && form) {
    if (form.busy) e.preventDefault();
    return;
  }
  if (form?.busy) {
    if (cancel && form.abortable) form.abort();
    else {
      e.preventDefault();
      return;
    }
  }
  if (own.busy) {
    e.preventDefault();
    return;
  }
  if (onclick) own.run((wait) => onclick(e, wait));
}

/** Whether a kit button is blocked right now, and whether it shows the spinner. */
export function buttonState({ own, form, submit, cancel }) {
  if (submit && form) return { blocked: form.busy, spinning: form.spinning };
  return { blocked: own.busy || (!!form?.busy && !(cancel && form.abortable)), spinning: own.spinning };
}

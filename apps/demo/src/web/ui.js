// Small helpers every page of the demo uses: building elements, messages, and JSON requests.

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

export const button = (text, onclick, props = {}) => el("button", { type: "button", textContent: text, onclick, ...props });
export const link = (text, href) => el("a", { textContent: text, href });
export const when = (date) => new Date(date).toLocaleString();
export const section = (title, ...children) => el("section", { className: "card" }, el("h2", { textContent: title }), ...children);
export const empty = (text) => el("p", { className: "muted", textContent: text });

let timer;
export function flash(text, kind = "info") {
  const box = $("flash");
  box.textContent = text;
  box.className = text ? kind : "";
  clearTimeout(timer);
  if (text && kind !== "error") timer = setTimeout(() => flash(""), 6000);
}

// Runs an action from a button or form, showing its error instead of failing silently.
export const attempt = (work) => async (...args) => {
  try {
    await work(...args);
  } catch (error) {
    flash(error.message, "error");
  }
};

// The platform's own routes, answered as JSON: auth under /api/auth/, organizations under /api/platform/.
export async function request(path, { body, method } = {}) {
  const init = body === undefined ? { method: method ?? "GET" } : { method: method ?? "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message ?? data?.error ?? `request failed (${response.status})`);
  return data;
}

// A form whose submit runs `work` with its fields, then resets it.
export function form(fields, submit, work, className = "") {
  const node = el("form", { className }, ...fields, el("button", { textContent: submit }));
  node.addEventListener(
    "submit",
    attempt(async (event) => {
      event.preventDefault();
      await work(Object.fromEntries(new FormData(node)), node);
      node.reset();
    }),
  );
  return node;
}

export const input = (name, props = {}) => el("input", { name, ...props });
export const select = (name, options, props = {}) => el("select", { name, ...props }, ...options.map(([value, label]) => el("option", { value, textContent: label })));
export const LEVELS = ["read", "create", "write", "delete", "manage"];

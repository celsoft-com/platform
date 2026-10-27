// Sign-in, sign-up and password screens every app with auth gets. Class names are part of the
// public interface: an app restyles them with its own stylesheet, loaded after this one.

export const SCREEN_PATHS = ["/login", "/signup", "/forgot", "/reset", "/consent"] as const;
export type ScreenPath = (typeof SCREEN_PATHS)[number];

interface Field {
  name: string;
  label: string;
  type: string;
  autocomplete: string;
}

interface Screen {
  title: string;
  intro?: string;
  fields: Field[];
  button: string;
  links: [string, string][];
}

// Password managers pair a saved password with the field marked "username", even when it holds an email.
const email: Field = { name: "email", label: "Email", type: "email", autocomplete: "username" };
const password = (autocomplete: string, label = "Password"): Field => ({ name: "password", label, type: "password", autocomplete });

const SCREENS: Record<ScreenPath, Screen> = {
  "/login": {
    title: "Sign in",
    fields: [email, password("current-password")],
    button: "Sign in",
    links: [["/signup", "Create an account"], ["/forgot", "Forgot your password?"]],
  },
  "/signup": {
    title: "Create an account",
    fields: [{ name: "name", label: "Name", type: "text", autocomplete: "name" }, email, password("new-password")],
    button: "Create account",
    links: [["/login", "Already have an account? Sign in"]],
  },
  "/forgot": {
    title: "Reset your password",
    intro: "Enter your email and we'll send you a link to choose a new password.",
    fields: [email],
    button: "Send reset link",
    links: [["/login", "Back to sign in"]],
  },
  "/reset": {
    title: "Choose a new password",
    fields: [password("new-password", "New password")],
    button: "Change password",
    links: [["/login", "Back to sign in"]],
  },
  // Where an AI client a person is connecting asks to act as them, through the app's MCP server.
  "/consent": {
    title: "Allow access",
    intro: "An AI app wants to use this app as you.",
    fields: [],
    button: "Allow",
    links: [["#deny", "Deny"]],
  },
};

export function isScreen(pathname: string): pathname is ScreenPath {
  return (SCREEN_PATHS as readonly string[]).includes(pathname);
}

export function renderScreen(path: ScreenPath, appName: string, stylesheet: string | undefined): Response {
  const screen = SCREENS[path];
  const fields = screen.fields
    .map(
      (f) => `<label class="platform-field"><span class="platform-label">${f.label}</span>` +
        `<input class="platform-input" id="${f.name}" name="${f.name}" type="${f.type}" autocomplete="${f.autocomplete}" required${f.type === "password" ? ' minlength="8"' : ""}></label>`,
    )
    .join("");
  const links = screen.links.map(([href, text]) => `<a href="${href}" data-carry>${text}</a>`).join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${screen.title} · ${escape(appName)}</title>
<style>${STYLE}</style>${stylesheet ? `<link rel="stylesheet" href="${escape(stylesheet)}">` : ""}
</head><body class="platform-screen" data-page="${path.slice(1)}">
<main class="platform-card">
<p class="platform-app">${escape(appName)}</p>
<h1 class="platform-title">${screen.title}</h1>
${screen.intro ? `<p class="platform-intro">${screen.intro}</p>` : ""}
<form class="platform-form" method="post" action="${path}" novalidate>${path === "/reset" ? '<input id="email" name="email" type="email" autocomplete="username" hidden>' : ""}${fields}
<p class="platform-error" role="alert" hidden></p>
<button class="platform-button" type="submit">${screen.button}</button></form>
<div class="platform-message" role="status" hidden></div>
<nav class="platform-links">${links}</nav>
</main>
<script>${SCRIPT}</script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
:root{--platform-bg:#f4f6f8;--platform-card:#fff;--platform-fg:#1b2430;--platform-muted:#5d6a78;--platform-line:#d5dce3;--platform-accent:#2554c7;--platform-on-accent:#fff;--platform-error:#b42318;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--platform-bg:#11161c;--platform-card:#19212a;--platform-fg:#e6ebf0;--platform-muted:#9aa7b4;--platform-line:#2c3742;--platform-accent:#7aa2ff;--platform-on-accent:#0b1220;--platform-error:#ff8a80}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body.platform-screen{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--platform-bg);color:var(--platform-fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.platform-card{width:100%;max-width:380px;background:var(--platform-card);border:1px solid var(--platform-line);border-radius:12px;padding:28px 24px;display:flex;flex-direction:column;gap:16px}
.platform-app{margin:0;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--platform-muted)}
.platform-title{margin:0;font-size:24px;line-height:1.2}
.platform-intro{margin:0;color:var(--platform-muted)}
.platform-form{display:flex;flex-direction:column;gap:14px}
.platform-field{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600}
.platform-input{font:inherit;font-weight:400;padding:10px 12px;border:1px solid var(--platform-line);border-radius:8px;background:var(--platform-bg);color:inherit}
.platform-input:focus-visible,.platform-button:focus-visible,.platform-links a:focus-visible{outline:2px solid var(--platform-accent);outline-offset:2px}
.platform-button{font:inherit;font-weight:600;padding:11px 14px;border:0;border-radius:8px;background:var(--platform-accent);color:var(--platform-on-accent);cursor:pointer}
.platform-button[disabled]{opacity:.6;cursor:progress}
.platform-error{margin:0;color:var(--platform-error);font-size:14px}
.platform-message{display:flex;flex-direction:column;gap:12px}
.platform-message p{margin:0}
.platform-code{font:600 18px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.04em;padding:12px;border:1px dashed var(--platform-line);border-radius:8px;text-align:center;word-break:break-all;user-select:all}
.platform-links{display:flex;flex-direction:column;gap:6px;font-size:14px}
.platform-links a{color:var(--platform-accent)}
`;

const SCRIPT = `
const page = document.body.dataset.page;
const params = new URLSearchParams(location.search);
// Only a path on this site, as the browser itself reads it, so "//x", "/\\x" and the like stay here.
const next = (p => { try { const u = new URL(p, location.origin); return p[0] === "/" && u.origin === location.origin ? u.pathname + u.search + u.hash : "/"; } catch { return "/"; } })(params.get("next") || "/");
// An AI client signing in through OAuth arrives with a signed query; it rides along on sign-in,
// sign-up and consent, and the answer says where to go next. Kept to the signed parameters only.
const oauthQuery = (() => {
  if (!params.has("sig")) return undefined;
  const signed = new Set(params.getAll("ba_param"));
  if (!signed.size) return undefined;
  return new URLSearchParams([...params].filter(([k]) => k === "sig" || k === "ba_param" || signed.has(k))).toString();
})();
const carried = new URLSearchParams([...params].filter(([k]) => k === "next" || k === "invitation" || oauthQuery)).toString();
for (const a of document.querySelectorAll("[data-carry]")) if (carried) a.href += "?" + carried;
const form = document.querySelector(".platform-form");
const error = document.querySelector(".platform-error");
const message = document.querySelector(".platform-message");

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 429 ? "Too many attempts. Wait a minute, then try again." : data.message || "That didn't work. Try again.");
  return data || {};
}

function say(...parts) {
  form.hidden = true;
  message.replaceChildren(...parts.map(p => typeof p === "string" ? Object.assign(document.createElement("p"), { textContent: p }) : p));
  message.hidden = false;
}

function follow(data) {
  if (data && data.url) { location.assign(data.url); return true; }
  return false;
}

async function finish() {
  const invitation = params.get("invitation");
  if (invitation) await post("/api/platform/invitations/" + encodeURIComponent(invitation) + "/accept", {}).catch(() => {});
  location.assign(next);
}

const actions = {
  login: async v => { if (!follow(await post("/api/auth/sign-in/email", { email: v.email, password: v.password, oauth_query: oauthQuery }))) await finish(); },
  signup: async v => {
    const data = await post("/api/auth/sign-up/email", { name: v.name, email: v.email, password: v.password, oauth_query: oauthQuery, callbackURL: "/login" + (carried ? "?" + carried : "") });
    if (follow(data)) return;
    if (data.token) return finish();
    say("Check your email for a link to confirm your address. It signs you in.");
  },
  forgot: async v => { await post("/api/auth/request-password-reset", { email: v.email, redirectTo: "/reset?email=" + encodeURIComponent(v.email) }); say("If that address has an account, a reset link is on its way."); },
  reset: async v => { await post("/api/auth/reset-password", { newPassword: v.password, token: params.get("token") }); say("Your password is changed. Sign in with it now."); },
  consent: async () => { follow(await post("/api/auth/oauth2/consent", { accept: true, oauth_query: oauthQuery })); },
};

if (page === "consent") {
  const deny = document.querySelector('a[href^="#deny"]');
  deny.addEventListener("click", async e => {
    e.preventDefault();
    try { follow(await post("/api/auth/oauth2/consent", { accept: false, oauth_query: oauthQuery })); }
    catch (err) { error.textContent = err.message; error.hidden = false; }
  });
  const scopes = { openid: "know who you are", profile: "see your name", email: "see your email address", offline_access: "stay connected until you disconnect it" };
  const wants = (params.get("scope") || "").split(" ").filter(Boolean).map(s => scopes[s] || s);
  fetch("/api/auth/oauth2/public-client?client_id=" + encodeURIComponent(params.get("client_id") || ""), { credentials: "same-origin" })
    .then(r => r.ok ? r.json() : {}).catch(() => ({}))
    .then(c => {
      const intro = document.querySelector(".platform-intro");
      intro.textContent = (c.client_name || "An AI app") + " wants to use this app as you" + (wants.length ? ", to " + wants.join(", ") : "") + ".";
    });
}

form.addEventListener("submit", async e => {
  e.preventDefault();
  error.hidden = true;
  if (!form.reportValidity()) return;
  const button = form.querySelector("button");
  button.disabled = true;
  try { await actions[page](Object.fromEntries(new FormData(form))); }
  catch (err) { error.textContent = err.message; error.hidden = false; }
  finally { button.disabled = false; }
});

// The reset link carries the email, so a password manager knows which saved login to update.
if (page === "reset") document.getElementById("email").value = params.get("email") || "";
if (page === "reset" && (params.get("error") || !params.get("token"))) say("That reset link has expired or was already used. Ask for a new one from the sign-in page.");
if (page === "login" && !oauthQuery) fetch("/api/auth/get-session", { credentials: "same-origin" }).then(r => r.json()).then(s => s && s.session && finish()).catch(() => {});
`;

// The API tokens screen: the signed-in person's tokens, making one shown exactly once, and revoking.
export const TOKENS_PATH = "/tokens";

export function renderTokensScreen(appName: string, stylesheet: string | undefined): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API tokens · ${escape(appName)}</title>
<style>${STYLE}${TOKENS_STYLE}</style>${stylesheet ? `<link rel="stylesheet" href="${escape(stylesheet)}">` : ""}
</head><body class="platform-screen" data-page="tokens">
<main class="platform-card platform-wide">
<p class="platform-app">${escape(appName)}</p>
<h1 class="platform-title">API tokens</h1>
<p class="platform-intro">A token lets a script call this app's API as you, sent as <code>Authorization: Bearer &lt;token&gt;</code>. Its level caps what it can do, so a leaked token can do no more.</p>
<form class="platform-form" novalidate>
<label class="platform-field"><span class="platform-label">Name</span><input class="platform-input" name="name" required maxlength="100" placeholder="What it is for"></label>
<label class="platform-field"><span class="platform-label">Level</span><select class="platform-input" name="cap">
<option value="read">read: look, never change</option><option value="create">create</option><option value="write">write</option><option value="delete">delete</option><option value="manage" selected>manage: all you can do</option></select></label>
<label class="platform-field"><span class="platform-label">Expires after (days, 1 to 365)</span><input class="platform-input" name="days" type="number" min="1" max="365" value="90" required></label>
<p class="platform-error" role="alert" hidden></p>
<button class="platform-button" type="submit">Make a token</button></form>
<div class="platform-message" role="status" hidden></div>
<ul class="platform-tokens"></ul>
<nav class="platform-links"><a href="/">Back to the app</a></nav>
</main>
<script>${TOKENS_SCRIPT}</script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const TOKENS_STYLE = `
.platform-wide{max-width:560px}
.platform-tokens{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.platform-tokens li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--platform-line);font-size:14px}
.platform-tokens small{display:block;color:var(--platform-muted)}
.platform-tokens button{font:inherit;padding:6px 10px;border:1px solid var(--platform-line);border-radius:8px;background:transparent;color:var(--platform-error);cursor:pointer}
`;

const TOKENS_SCRIPT = `
const form = document.querySelector(".platform-form");
const error = document.querySelector(".platform-error");
const message = document.querySelector(".platform-message");
const list = document.querySelector(".platform-tokens");

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || "That didn't work. Try again.");
  return data;
}

const when = d => d ? new Date(d).toLocaleString() : "never";

async function load() {
  const r = await fetch("/api/auth/api-key/list", { credentials: "same-origin" });
  if (r.status === 401) { location.assign("/login?next=" + encodeURIComponent("/tokens")); return; }
  const data = await r.json().catch(() => []);
  const keys = Array.isArray(data) ? data : (data.apiKeys || []);
  list.replaceChildren(...keys.map(k => {
    const li = document.createElement("li");
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = k.name || "(no name)";
    const meta = document.createElement("small");
    const cap = (k.metadata && k.metadata.cap) || "manage";
    meta.textContent = (k.start || "") + "… · level " + cap + " · last used " + when(k.lastRequest) + " · expires " + when(k.expiresAt);
    text.append(name, meta);
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.textContent = "Revoke";
    revoke.onclick = async () => {
      if (!confirm("Revoke " + (k.name || "this token") + "? Scripts using it stop working at once.")) return;
      try { await post("/api/auth/api-key/delete", { keyId: k.id }); load(); }
      catch (err) { error.textContent = err.message; error.hidden = false; }
    };
    li.append(text, revoke);
    return li;
  }));
}

form.addEventListener("submit", async e => {
  e.preventDefault();
  error.hidden = true;
  if (!form.reportValidity()) return;
  const v = Object.fromEntries(new FormData(form));
  try {
    const made = await post("/api/auth/api-key/create", { name: v.name, expiresIn: Number(v.days) * 86400, metadata: { cap: v.cap } });
    const note = document.createElement("p");
    note.textContent = "Copy it now; it is never shown again.";
    const code = document.createElement("p");
    code.className = "platform-code";
    code.textContent = made.key;
    message.replaceChildren(note, code);
    message.hidden = false;
    form.reset();
    load();
  } catch (err) { error.textContent = err.message; error.hidden = false; }
});

load();
`;

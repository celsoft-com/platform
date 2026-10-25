// Sign-in, sign-up and password screens every app with auth gets. Class names are part of the
// public interface: an app restyles them with its own stylesheet, loaded after this one.

export const SCREEN_PATHS = ["/login", "/signup", "/forgot", "/reset"] as const;
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
const next = (p => p && p.startsWith("/") && !p.startsWith("//") ? p : "/")(params.get("next"));
const carried = new URLSearchParams([...params].filter(([k]) => k === "next" || k === "invitation")).toString();
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

async function finish() {
  const invitation = params.get("invitation");
  if (invitation) await post("/api/auth/organization/accept-invitation", { invitationId: invitation }).catch(() => {});
  location.assign(next);
}

const actions = {
  login: async v => { await post("/api/auth/sign-in/email", { email: v.email, password: v.password }); await finish(); },
  signup: async v => {
    const data = await post("/api/auth/sign-up/email", { name: v.name, email: v.email, password: v.password, callbackURL: "/login" + (carried ? "?" + carried : "") });
    if (data.token) return finish();
    say("Check your email for a link to confirm your address. It signs you in.");
  },
  forgot: async v => { await post("/api/auth/request-password-reset", { email: v.email, redirectTo: "/reset?email=" + encodeURIComponent(v.email) }); say("If that address has an account, a reset link is on its way."); },
  reset: async v => { await post("/api/auth/reset-password", { newPassword: v.password, token: params.get("token") }); say("Your password is changed. Sign in with it now."); },
};

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
if (page === "login") fetch("/api/auth/get-session", { credentials: "same-origin" }).then(r => r.json()).then(s => s && s.session && finish()).catch(() => {});
`;

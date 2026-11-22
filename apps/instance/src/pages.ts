// The instance's pages, in the same document and style as the platform's sign-in screens.

import { escape, htmlDocument } from "../../../packages/platform/src/runtime/html.ts";
import { STYLE } from "../../../packages/platform/src/runtime/screens.ts";
import { PERMISSIONS } from "./cloudflare.ts";
import { ADMIN_PATH, type Self } from "./setup.ts";

const KEYS = [
  { key: "workers_scripts", type: "edit" },
  { key: "account_settings", type: "read" },
  { key: "access", type: "edit" },
  { key: "access_acct", type: "edit" },
];

export const TOKEN_URL = `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(JSON.stringify(KEYS))}&name=${encodeURIComponent("platform setup")}`;

// Which deploy is serving, so whoever reports a problem can say what they were running.
function build(self: Self): string {
  const when = self.deployedAt ? ` · ${self.deployedAt.slice(0, 16).replace("T", " ")} UTC` : "";
  return `<footer class="instance-build">Build ${escape(self.version.slice(0, 8))}${escape(when)}</footer>`;
}

function page(self: Self, title: string, body: string, status = 200): Response {
  const html = htmlDocument({ title, appName: "Platform", style: STYLE + EXTRA, page: "instance", body: `<main class="platform-card">\n<p class="platform-app">Platform</p>\n${body}\n</main>\n${build(self)}` });
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const EXTRA = `.platform-intro ul{margin:8px 0 0;padding-left:20px}.platform-links a{word-break:break-word}
.instance-build{position:fixed;right:12px;bottom:8px;font-size:12px;color:var(--platform-muted)}
.instance-steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:14px}
.instance-done::before{content:"✓ ";color:var(--platform-accent);font-weight:700}
.instance-failed{color:var(--platform-error)}.instance-failed::before{content:"✗ ";font-weight:700}
.instance-action{display:block;text-align:center;text-decoration:none}
.instance-more{display:flex;flex-direction:column;gap:12px;font-size:14px}.instance-more summary{cursor:pointer;color:var(--platform-accent)}
.instance-more[open]>*+*{margin-top:12px}`;

// What the last submit did: the steps it finished, the error that stopped it, and the email typed, kept for a retry.
export interface Result {
  email: string;
  done: string[];
  error?: string;
}

const empty: Result = { email: "", done: [] };

function steps(result: Result): string {
  if (!result.done.length && !result.error) return "";
  const lines = result.done.map((d) => `<li class="instance-done">${escape(d)}</li>`);
  if (result.error) lines.push(`<li class="instance-failed" role="alert">${escape(result.error)}</li>`);
  return `<ul class="instance-steps">${lines.join("")}</ul>`;
}

function tokenForm(action: string, button: string, result: Result): string {
  const permissions = Object.values(PERMISSIONS).map((p) => `<li>${escape(p)}</li>`).join("");
  return `<form class="platform-form" method="post" action="${action}">
<p class="platform-intro">Create a token on this Cloudflare account with these account permissions:<ul>${permissions}</ul></p>
<nav class="platform-links"><a href="${escape(TOKEN_URL)}" target="_blank" rel="noopener">Create token</a></nav>
<p class="platform-intro">Paste the token this link makes, named <strong>platform setup</strong>. The build token Cloudflare made for this Worker won't work.</p>
<label class="platform-field"><span class="platform-label">Token</span><input class="platform-input" name="token" type="password" autocomplete="off" required></label>
<label class="platform-field"><span class="platform-label">Your email</span><input class="platform-input" name="email" type="email" autocomplete="email" value="${escape(result.email)}" required></label>
<button class="platform-button" type="submit">${button}</button></form>`;
}

export function setupPage(self: Self, result: Result = empty): Response {
  return page(
    self,
    "Set up",
    `<h1 class="platform-title">Set up this instance</h1>
<p class="platform-intro">Paste a token for this Cloudflare account and your email. You become the super admin once you sign in with the code Cloudflare emails you.</p>
${steps(result)}
${tokenForm("/", "Reserve", result)}`,
    result.error ? 400 : 200,
  );
}

export function waitingPage(self: Self, reserved: string, result: Result = empty): Response {
  const who = escape(reserved);
  return page(
    self,
    "Sign in",
    `<h1 class="platform-title">One step left: sign in</h1>
<p class="platform-intro">Sign in as <strong>${who}</strong>, the email you entered. Cloudflare emails a code to that address; enter it on Cloudflare's sign-in page and you become the super admin.</p>
${result.error ? "" : steps(result)}
<a class="platform-button instance-action" href="${ADMIN_PATH}">Sign in as ${who}</a>
<details class="instance-more"${result.error ? " open" : ""}><summary>Wrong email, or no code arriving?</summary>
<p class="platform-intro">Submit a token with the right email; it replaces the reservation for ${who}.</p>
${result.error ? steps(result) : ""}
${tokenForm("/", "Reserve again", result)}</details>`,
    result.error ? 400 : 200,
  );
}

export function resetPage(self: Self, result: Result = empty): Response {
  return page(
    self,
    "Reset the super admin",
    `<h1 class="platform-title">Reset the super admin</h1>
<p class="platform-intro">For a super admin who lost their email. A token for this Cloudflare account and a new email reserve the instance again for that email.</p>
${steps(result)}
${tokenForm("/reset", "Reset", result)}`,
    result.error ? 400 : 200,
  );
}

export function homePage(self: Self, email: string): Response {
  return page(
    self,
    "Home",
    `<h1 class="platform-title">Initial setup is complete</h1>
<p class="platform-intro">You are the super admin of this instance, signed in as <strong>${escape(email)}</strong>.</p>
<ul class="instance-steps">
<li class="instance-done">Cloudflare Access guards this page; only ${escape(email)} can sign in.</li>
<li class="instance-done">The instance holds its Cloudflare token as a secret.</li>
</ul>
<p class="platform-intro">Next comes complete setup, which lets this instance deploy apps. It is not built yet; it arrives in a later version of the repo you deployed from.</p>
<nav class="platform-links"><a href="/cdn-cgi/access/logout">Sign out</a></nav>`,
  );
}

export function refusedPage(self: Self): Response {
  return page(self, "Not signed in", `<h1 class="platform-title">Not signed in as the super admin</h1>`, 403);
}

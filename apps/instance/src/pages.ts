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
.instance-build{position:fixed;right:12px;bottom:8px;font-size:12px;color:var(--platform-muted)}`;

function tokenForm(action: string, button: string, error?: string, email = ""): string {
  const permissions = Object.values(PERMISSIONS).map((p) => `<li>${escape(p)}</li>`).join("");
  return `<form class="platform-form" method="post" action="${action}">
<p class="platform-intro">Create a token on this Cloudflare account with these account permissions:<ul>${permissions}</ul></p>
<nav class="platform-links"><a href="${escape(TOKEN_URL)}" target="_blank" rel="noopener">Create token</a></nav>
<p class="platform-intro">Paste the token this link makes, named <strong>platform setup</strong>. The build token Cloudflare made for this Worker won't work.</p>
<label class="platform-field"><span class="platform-label">Token</span><input class="platform-input" name="token" type="password" autocomplete="off" required></label>
<label class="platform-field"><span class="platform-label">Your email</span><input class="platform-input" name="email" type="email" autocomplete="email" value="${escape(email)}" required></label>
${error ? `<p class="platform-error" role="alert">${escape(error)}</p>` : ""}
<button class="platform-button" type="submit">${button}</button></form>`;
}

export function setupPage(self: Self, error?: string, email?: string): Response {
  return page(
    self,
    "Set up",
    `<h1 class="platform-title">Set up this instance</h1>
<p class="platform-intro">Paste a token for this Cloudflare account and your email. You become the super admin once you sign in with the code Cloudflare emails you.</p>
${tokenForm("/", "Reserve", error, email)}`,
    error ? 400 : 200,
  );
}

export function waitingPage(self: Self, reserved: string, error?: string, email?: string): Response {
  return page(
    self,
    "Waiting for sign-in",
    `<h1 class="platform-title">Waiting for sign-in</h1>
<p class="platform-intro">Reserved for <strong>${escape(reserved)}</strong>. Sign in with the code Cloudflare emails to that address to become the super admin.</p>
<nav class="platform-links"><a href="${ADMIN_PATH}">Sign in</a></nav>
<p class="platform-intro">Wrong email, or no code coming? Submit a token with the right email to replace the reservation.</p>
${tokenForm("/", "Reserve again", error, email)}`,
    error ? 400 : 200,
  );
}

export function resetPage(self: Self, error?: string, email?: string): Response {
  return page(
    self,
    "Reset the super admin",
    `<h1 class="platform-title">Reset the super admin</h1>
<p class="platform-intro">For a super admin who lost their email. A token for this Cloudflare account and a new email reserve the instance again for that email.</p>
${tokenForm("/reset", "Reset", error, email)}`,
    error ? 400 : 200,
  );
}

export function homePage(self: Self, email: string): Response {
  return page(
    self,
    "Home",
    `<h1 class="platform-title">Initial setup is done</h1>
<p class="platform-intro">You are the super admin of this instance, signed in as <strong>${escape(email)}</strong>. Complete setup, which enables apps, comes next.</p>
<nav class="platform-links"><a href="/cdn-cgi/access/logout">Sign out</a></nav>`,
  );
}

export function refusedPage(self: Self): Response {
  return page(self, "Not signed in", `<h1 class="platform-title">Not signed in as the super admin</h1>`, 403);
}

// The instance's pages, in the same document and style as the platform's sign-in screens.

import { escape, htmlDocument } from "../../../packages/platform/src/runtime/html.ts";
import { STYLE } from "../../../packages/platform/src/runtime/screens.ts";
import { PERMISSIONS } from "./cloudflare.ts";
import { ADMIN_PATH } from "./setup.ts";

const KEYS = [
  { key: "workers_scripts", type: "edit" },
  { key: "account_settings", type: "read" },
  { key: "access", type: "edit" },
  { key: "access_acct", type: "edit" },
];

export const TOKEN_URL = `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(JSON.stringify(KEYS))}&name=platform`;

function page(title: string, body: string, status = 200): Response {
  const html = htmlDocument({ title, appName: "Platform", style: STYLE + EXTRA, page: "instance", body: `<main class="platform-card">\n<p class="platform-app">Platform</p>\n${body}\n</main>` });
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const EXTRA = `.platform-intro ul{margin:8px 0 0;padding-left:20px}.platform-links a{word-break:break-word}`;

function tokenForm(action: string, button: string, error?: string, email = ""): string {
  const permissions = Object.values(PERMISSIONS).map((p) => `<li>${escape(p)}</li>`).join("");
  return `<form class="platform-form" method="post" action="${action}">
<p class="platform-intro">Create a token on this Cloudflare account with these account permissions:<ul>${permissions}</ul></p>
<nav class="platform-links"><a href="${escape(TOKEN_URL)}" target="_blank" rel="noopener">Create token</a></nav>
<label class="platform-field"><span class="platform-label">Token</span><input class="platform-input" name="token" type="password" autocomplete="off" required></label>
<label class="platform-field"><span class="platform-label">Your email</span><input class="platform-input" name="email" type="email" autocomplete="email" value="${escape(email)}" required></label>
${error ? `<p class="platform-error" role="alert">${escape(error)}</p>` : ""}
<button class="platform-button" type="submit">${button}</button></form>`;
}

export function setupPage(error?: string, email?: string): Response {
  return page(
    "Set up",
    `<h1 class="platform-title">Set up this instance</h1>
<p class="platform-intro">Paste a token for this Cloudflare account and your email. You become the super admin once you sign in with the code Cloudflare emails you.</p>
${tokenForm("/", "Reserve", error, email)}`,
    error ? 400 : 200,
  );
}

export function waitingPage(reserved: string, error?: string, email?: string): Response {
  return page(
    "Waiting for sign-in",
    `<h1 class="platform-title">Waiting for sign-in</h1>
<p class="platform-intro">Reserved for <strong>${escape(reserved)}</strong>. Sign in with the code Cloudflare emails to that address to become the super admin.</p>
<nav class="platform-links"><a href="${ADMIN_PATH}">Sign in</a></nav>
<p class="platform-intro">Wrong email, or no code coming? Submit a token with the right email to replace the reservation.</p>
${tokenForm("/", "Reserve again", error, email)}`,
    error ? 400 : 200,
  );
}

export function resetPage(error?: string, email?: string): Response {
  return page(
    "Reset the super admin",
    `<h1 class="platform-title">Reset the super admin</h1>
<p class="platform-intro">For a super admin who lost their email. A token for this Cloudflare account and a new email reserve the instance again for that email.</p>
${tokenForm("/reset", "Reset", error, email)}`,
    error ? 400 : 200,
  );
}

export function homePage(email: string): Response {
  return page(
    "Home",
    `<h1 class="platform-title">Initial setup is done</h1>
<p class="platform-intro">You are the super admin of this instance, signed in as <strong>${escape(email)}</strong>. Complete setup, which enables apps, comes next.</p>
<nav class="platform-links"><a href="/cdn-cgi/access/logout">Sign out</a></nav>`,
  );
}

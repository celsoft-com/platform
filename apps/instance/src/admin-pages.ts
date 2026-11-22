// The admin pages: the super admin's Complete Setup checklist and its six steps, and a platform admin's home.

import { escape } from "../../../packages/platform/src/runtime/html.ts";
import { APP_PERMISSIONS, PERMISSIONS, REVOKED } from "./cloudflare.ts";
import { page, SETUP_KEYS, steps, tokenUrl, type Result } from "./pages.ts";
import type { InstanceRecord, Self } from "./setup.ts";

const APP_KEYS = [
  ...SETUP_KEYS,
  { key: "721b2f51fba74871bd361de65aeb7e03", type: "edit" }, // Hyperdrive Write
  { key: "bf7481a1826f439697cb59a20b22293e", type: "edit" }, // Workers R2 Storage Write
  { key: "c8fed203ed3043cba015a93ad1616f1f", type: "read" }, // Zone Read
  { key: "4755a26eedb94da69e1066d98aa820be", type: "edit" }, // DNS Write
  { key: "28f4b596e7d643029c524985477ae49a", type: "edit" }, // Workers Routes Write
];
const WIDER_TOKEN_URL = tokenUrl(APP_KEYS, "platform");

const noResult: Result = { email: "", done: [] };
const signOut = `<nav class="platform-links"><a href="/cdn-cgi/access/logout">Sign out</a></nav>`;
const back = `<nav class="platform-links"><a href="/admin">Back to complete setup</a></nav>`;

interface Step {
  path: string;
  name: string;
  done: boolean;
  says: string;
}

function checklist(record: InstanceRecord, tokenWorks: boolean): Step[] {
  const setup = record.setup ?? {};
  const github = setup.github;
  return [
    {
      path: "token",
      name: "Wider token",
      done: !!setup.token && tokenWorks,
      says: !tokenWorks ? "The token stopped working; create a new one." : setup.token ? "The token can deploy apps." : "Give the instance a token that can deploy apps.",
    },
    {
      path: "github",
      name: "GitHub App",
      done: !!github,
      says: github ? `${github.slug}, owned by ${github.owner}; each app's repo is added to it when the app is added.` : "Create the instance's own GitHub App.",
    },
    { path: "database", name: "Database", done: !!setup.neon, says: setup.neon ? "Neon is connected." : "Connect Neon, where apps' databases live." },
    { path: "email", name: "Email", done: !!setup.resend, says: setup.resend ? "Resend is connected." : "Connect Resend, which sends apps' email." },
    { path: "admins", name: "Platform admins", done: !!record.admins?.length, says: record.admins?.length ? record.admins.join(", ") : "Name the people who will manage apps." },
  ];
}

export function superHome(self: Self, email: string, record: InstanceRecord, tokenWorks: boolean): Response {
  const list = checklist(record, tokenWorks);
  const finished = list.every((s) => s.done);
  const items = list.map((s) => `<li class="${s.done ? "instance-done" : "instance-todo"}"><a href="/admin/${s.path}">${s.name}</a>: ${escape(s.says)}</li>`).join("");
  return page(
    self,
    "Complete setup",
    `<h1 class="platform-title">${finished ? "Setup is complete" : "Complete setup"}</h1>
<p class="platform-intro">Signed in as <strong>${escape(email)}</strong>, the super admin. ${finished ? "Every step is done. Adding apps comes in a later version." : "Each step lets this instance deploy apps; do them in order."}</p>
${tokenWorks ? "" : `<ul class="instance-steps"><li class="instance-failed" role="alert">${escape(REVOKED)} <a href="/admin/token">Create a new token</a></li></ul>`}
<ul class="instance-steps">${items}</ul>
${signOut}`,
  );
}

export function platformHome(self: Self, email: string): Response {
  return page(
    self,
    "Home",
    `<h1 class="platform-title">You are a platform admin</h1>
<p class="platform-intro">Signed in as <strong>${escape(email)}</strong>. Platform admins add and manage apps; that comes in a later version of this instance.</p>
${signOut}`,
  );
}

const ORDER = [
  ["token", "Wider token"],
  ["github", "GitHub App"],
  ["database", "Database"],
  ["email", "Email"],
  ["admins", "Platform admins"],
] as const;

// A step that just finished drops its form and leads straight to the next one.
function stepPage(self: Self, title: string, intro: string, form: string, result: Result, finished = result.done.length > 0 && !result.error): Response {
  const at = ORDER.findIndex(([, name]) => name === title);
  const next = ORDER[at + 1];
  const onward = next
    ? `<a class="platform-button instance-action" href="/admin/${next[0]}">Next: ${next[1]}</a>\n${back}`
    : `<a class="platform-button instance-action" href="/admin">Back to complete setup</a>`;
  return page(self, title, `<h1 class="platform-title">${title}</h1>\n<p class="platform-intro">${intro}</p>\n${steps(result)}\n${finished ? onward : `${form}\n${back}`}`, result.error ? 400 : 200);
}

const secretField = (name: string, label: string) =>
  `<label class="platform-field"><span class="platform-label">${label}</span><input class="platform-input" name="${name}" type="password" autocomplete="off" required></label>`;

export function tokenStep(self: Self, result: Result = noResult, tokenWorks = true): Response {
  const permissions = [...Object.values(PERMISSIONS), ...Object.values(APP_PERMISSIONS)].map((p) => `<li>${escape(p)}</li>`).join("");
  return stepPage(
    self,
    "Wider token",
    tokenWorks
      ? "Deploying apps needs more than setup did. Create a token with these permissions, the zone ones on all zones; it replaces the setup token."
      : "The instance's token stopped working: it was revoked, expired or deleted. Create a new one with these permissions, the zone ones on all zones, and paste it here.",
    `<form class="platform-form" method="post">
<ul class="platform-intro">${permissions}</ul>
<nav class="platform-links"><a href="${escape(WIDER_TOKEN_URL)}" target="_blank" rel="noopener">Create token</a></nav>
<p class="platform-intro">If Cloudflare's page says it could not add a permission, add it there by hand before creating the token.</p>
${secretField("token", "Token")}
<button class="platform-button" type="submit">Check and save</button></form>`,
    result,
  );
}

export function githubStep(self: Self, record: InstanceRecord, result: Result = noResult): Response {
  const github = record.setup?.github;
  const body = github
    ? `<p class="platform-intro"><strong>${escape(github.slug)}</strong> belongs to ${escape(github.owner)}. When an app is added, it is installed on that app's repo only.</p>`
    : `<form class="platform-form" method="post">
<p class="platform-intro">The app is private, so GitHub only lets it be installed where it belongs: name the org your app repos live in, or leave it empty if they are in your own account.</p>
<label class="platform-field"><span class="platform-label">GitHub org where your app repos live</span><input class="platform-input" name="owner" autocomplete="off"></label>
<button class="platform-button" type="submit">Next</button></form>`;
  return stepPage(self, "GitHub App", "The instance gets its own GitHub App, which reads app repos and hears their pushes and pull requests.", body, result);
}

// GitHub's manifest flow takes a form posted from the browser, so this page posts it.
export function githubSend(self: Self, action: string, manifest: string): Response {
  return stepPage(
    self,
    "GitHub App",
    "GitHub shows the app's settings; check its name, then create it. GitHub brings you back here.",
    `<form class="platform-form" method="post" action="${escape(action)}"><input type="hidden" name="manifest" value="${escape(manifest)}"><button class="platform-button" type="submit">Create on GitHub</button></form>`,
    noResult,
  );
}

export function databaseStep(self: Self, result: Result = noResult): Response {
  return stepPage(
    self,
    "Database",
    `Apps' databases live in Neon. In the <a href="https://console.neon.tech" target="_blank" rel="noopener">Neon console</a>, open your organization's <strong>Settings</strong>, then <strong>API keys</strong>, and create an organization API key.`,
    `<form class="platform-form" method="post">${secretField("key", "Neon API key")}<button class="platform-button" type="submit">Check and save</button></form>`,
    result,
  );
}

export function emailStep(self: Self, result: Result = noResult): Response {
  return stepPage(
    self,
    "Email",
    `Apps send email through Resend. Create an API key with <strong>Full access</strong> at <a href="https://resend.com/api-keys" target="_blank" rel="noopener">resend.com/api-keys</a>; the instance adds each app's sending domain with it.`,
    `<form class="platform-form" method="post">${secretField("key", "Resend API key")}<button class="platform-button" type="submit">Check and save</button></form>`,
    result,
  );
}

export function adminsStep(self: Self, record: InstanceRecord, result: Result = noResult): Response {
  return stepPage(
    self,
    "Platform admins",
    "Platform admins add and manage apps. They sign in here with an emailed code, like you, and never see these setup pages.",
    `<form class="platform-form" method="post">
<label class="platform-field"><span class="platform-label">Emails, one per line</span><textarea class="platform-input" name="emails">${escape((record.admins ?? []).join("\n"))}</textarea></label>
<button class="platform-button" type="submit">Save</button></form>`,
    result,
  );
}

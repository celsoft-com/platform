// The demo's pages, routed by the address's fragment, such as #/notes/<id>; a link token rides
// along as `&link=<token>`, which the generated client sends with every call.
import { call } from "../../.platform/client";
import { notePage, notesPage, sharedPage } from "./notes.js";
import { invitationsPage, orgPage, orgsPage, teamPage } from "./orgs.js";
import { settingsPage } from "./settings.js";
import { $, attempt, button, el, empty, flash, link, request } from "./ui.js";

let session = null;
let leaving = [];

const signedIn = () => session !== null;
const route = () => (location.hash.replace(/^#/, "").split("&")[0] || "/").replace(/\/$/, "") || "/";
const loginHref = () => `/login?next=${encodeURIComponent(`/${location.hash || "#/notes"}`)}`;

async function loadSession() {
  session = await request("/api/auth/get-session").catch(() => null);
}

async function invitationCount() {
  if (!signedIn() || !session.user.emailVerified) return 0;
  return (await request("/api/platform/invitations").catch(() => [])).length;
}

async function renderNav() {
  const here = route();
  const item = (text, href) => el("a", { textContent: text, href, className: here.startsWith(href.slice(1)) && href !== "#/" ? "active" : "" });
  const nav = $("nav");
  if (!signedIn()) {
    nav.replaceChildren(el("a", { href: "#/", className: "brand", textContent: "Notes demo" }), el("span", { className: "spacer" }), el("a", { href: loginHref(), textContent: "Sign in" }), el("a", { href: "/signup", textContent: "Sign up" }));
    return;
  }
  const count = await invitationCount();
  nav.replaceChildren(
    el("a", { href: "#/notes", className: "brand", textContent: "Notes demo" }),
    item("My notes", "#/notes"),
    item("Shared with me", "#/shared"),
    item("Organizations", "#/orgs"),
    item(count ? `Invitations (${count})` : "Invitations", "#/invitations"),
    el("a", { href: "/tokens", textContent: "API tokens" }),
    el("span", { className: "spacer" }),
    item(session.user.name, "#/settings"),
    button("Sign out", attempt(signOut)),
  );
}

async function signOut() {
  await request("/api/auth/sign-out", { body: {} });
  session = null;
  flash("Signed out.");
  location.hash = "#/";
  await render();
}

async function home() {
  const about = await call("about", {}).catch(() => null);
  return el(
    "div",
    {},
    el("h1", { textContent: "Notes, with every access feature" }),
    el("p", { textContent: "This demo app exists so people can try the platform by hand: personal notes shared by email, link or with Everyone; organizations with admins, invitations and teams; team notes; inheritance; moving notes between places." }),
    about ? empty(`The line you are reading is gated by a static control point that grants Everyone ${about.level}.`) : null,
    el("p", { className: "row" }, el("a", { className: "button", href: loginHref(), textContent: "Sign in" }), el("a", { className: "button", href: "/signup", textContent: "Create an account" })),
  );
}

// Pages that need a signed-in person show a sign-in prompt instead.
const routes = [
  [/^\/$/, () => (signedIn() ? ((location.hash = "#/notes"), null) : home())],
  [/^\/notes$/, () => notesPage(), true],
  [/^\/shared$/, () => sharedPage(call), true],
  [/^\/notes\/([0-9a-f-]{36})$/, ([id], ctx) => notePage(call, id, ctx)],
  [/^\/orgs$/, () => orgsPage(call), true],
  [/^\/orgs\/([0-9a-f-]{36})$/, ([id], ctx) => orgPage(call, id, ctx), true],
  [/^\/teams\/([0-9a-f-]{36})$/, ([id], ctx) => teamPage(call, id, ctx), true],
  [/^\/invitations$/, (_, ctx) => invitationsPage(ctx), true],
  [/^\/settings$/, (_, ctx) => settingsPage(ctx), true],
];

async function render() {
  for (const stop of leaving) stop();
  leaving = [];
  await renderNav();
  const path = route();
  const found = routes.map(([pattern, view, needsUser]) => [pattern.exec(path), view, needsUser]).find(([match]) => match);
  const main = $("main");
  if (!found) return main.replaceChildren(el("h1", { textContent: "Not found" }), link("Back to your notes", "#/notes"));
  const [match, view, needsUser] = found;
  if (needsUser && !signedIn()) return main.replaceChildren(el("h1", { textContent: "Sign in first" }), el("p", {}, el("a", { href: loginHref(), textContent: "Sign in" }), " or ", link("create an account", "/signup"), "."));
  const ctx = {
    session,
    me: session?.user ?? null,
    rerender: () => render(),
    refreshNav: async () => {
      await loadSession();
      await renderNav();
    },
    signOut,
    onLeave: (stop) => leaving.push(stop),
  };
  try {
    const page = await view(match.slice(1), ctx);
    if (page) main.replaceChildren(page);
  } catch (error) {
    main.replaceChildren(el("h1", { textContent: "Something went wrong" }), empty(error.message));
  }
}

addEventListener("hashchange", () => {
  flash("");
  render();
});

loadSession()
  .then(render)
  .catch((error) => flash(error.message, "error"));

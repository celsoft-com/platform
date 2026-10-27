import { attempt, button, el, empty, flash, form, input, LEVELS, link, request, section, select, when } from "./ui.js";

// Notes: the signed-in person's own, those shared with them, and one note with its permissions.

const firstLine = (body) => body.split("\n")[0].slice(0, 80) || "(empty)";

export function noteRow(note, { author } = {}) {
  return el(
    "li",
    {},
    link(firstLine(note.body), `#/notes/${note.id}`),
    note.attachmentName ? el("span", { className: "tag", textContent: "attachment" }) : null,
    el("span", { className: "muted", textContent: ` ${author ?? note.author ? `${author ?? note.author}, ` : ""}${when(note.createdAt)}` }),
  );
}

export async function notesPage() {
  const list = el("ul", { className: "list" });
  const load = async () => {
    const notes = await request("/api/notes");
    list.replaceChildren(...(notes.length ? notes.map((n) => noteRow(n)) : [el("li", {}, empty("No notes yet; write one above."))]));
  };
  const create = el(
    "form",
    {},
    el("textarea", { name: "body", placeholder: "Write a note", required: true, maxLength: 10000 }),
    el("label", {}, "Attach a file (up to 10 MB) ", el("input", { name: "file", type: "file" })),
    el("button", { textContent: "Add note" }),
  );
  create.addEventListener(
    "submit",
    attempt(async (event) => {
      event.preventDefault();
      const response = await fetch("/api/notes", { method: "POST", body: new FormData(create) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "could not save the note");
      create.reset();
      flash("Saved.");
      await load();
    }),
  );
  await load();
  return el("div", {}, el("h1", { textContent: "My notes" }), el("p", { className: "muted", textContent: "Personal notes stand alone: only you, and whoever you share one with, can see it." }), section("New note", create), section("Notes", list));
}

export async function sharedPage(call) {
  const shared = await call("sharedNotes", {});
  return el(
    "div",
    {},
    el("h1", { textContent: "Shared with me" }),
    el("p", { className: "muted", textContent: "Other people's personal notes you can read: shared with you, your email, your teams or organizations, or Everyone." }),
    section("Notes", shared.length ? el("ul", { className: "list" }, ...shared.map((n) => noteRow(n))) : empty("Nothing shared with you yet.")),
  );
}

// One note: anyone with read sees it, writers edit it, managers get its permissions.
export async function notePage(call, id, ctx) {
  let note;
  try {
    note = await call("getNote", { id });
  } catch {
    return el("div", {}, el("h1", { textContent: "Not found" }), empty("This note does not exist, or it is not shared with you."));
  }
  const level = LEVELS.indexOf(note.level);
  const place = note.teamId ? link("its team", `#/teams/${note.teamId}`) : note.organizationId ? link("its organization", `#/orgs/${note.organizationId}`) : "personal notes";
  const page = el(
    "div",
    {},
    el("h1", { textContent: firstLine(note.body) }),
    el("p", { className: "muted" }, `By ${note.author}, ${when(note.createdAt)}. Sits in `, place, `. Your level: `, el("strong", { textContent: note.level }), "."),
  );

  if (level >= 2) {
    page.append(
      section(
        "Note",
        form([el("textarea", { name: "body", required: true, maxLength: 10000, value: note.body })], "Save", async ({ body }, node) => {
          await call("editNote", { id, body });
          flash("Saved.");
          ctx.rerender();
        }),
      ),
    );
  } else page.append(section("Note", el("p", { className: "body", textContent: note.body })));
  if (note.attachmentName) page.append(el("p", {}, link(`Download ${note.attachmentName}`, `/api/public/notes/${id}/attachment`)));
  // Rendered by the Worker, not this app: a page the platform serves at a claimed path.
  page.append(el("p", {}, link("Printable page", `/print/${id}`)));

  if (level >= 4) page.append(await permissions(call, id, ctx));
  else if (ctx.me) page.append(empty("You do not manage this note, so its permissions are hidden."));
  if (level >= 3) {
    page.append(
      button(
        "Delete note",
        attempt(async () => {
          if (!confirm("Delete this note?")) return;
          await call("deleteNote", { id });
          flash("Deleted.");
          location.hash = "#/notes";
        }),
        { className: "danger" },
      ),
    );
  }
  return page;
}

// Grants, links, inheritance and place: everything a manager can change on a control point.
async function permissions(call, id, ctx) {
  const access = await call("noteAccess", { id });
  const orgs = ctx.me ? await call("listMyOrganizations", {}) : [];
  const teams = (await Promise.all(orgs.map(async (o) => (await request(`/api/platform/organizations/${o.id}/teams`).catch(() => [])).map((t) => ({ ...t, org: o }))))).flat();
  const refresh = () => ctx.rerender();

  const grants = el(
    "ul",
    { className: "list" },
    ...access.grants.map((g) =>
      el(
        "li",
        {},
        el("strong", { textContent: g.name }),
        ` has ${g.level} `,
        button(
          "Revoke",
          attempt(async () => {
            await call("revokeNote", { id, to: g.kind === "everyone" ? { kind: "everyone" } : { kind: g.kind, value: g.value } });
            refresh();
          }),
        ),
      ),
    ),
  );

  const kind = select("kind", [["email", "A person, by email"], ["team", "A team"], ["organization", "An organization"], ["everyone", "Everyone (read only)"]]);
  const email = input("email", { type: "email", placeholder: "their email" });
  const group = select("group", [
    ["", "choose"],
    ...orgs.map((o) => [`organization:${o.id}`, `Organization: ${o.name}`]),
    ...teams.map((t) => [`team:${t.id}`, `Team: ${t.org.name} / ${t.name}`]),
  ]);
  const level = select("level", LEVELS.map((l) => [l, l]));
  const sync = () => {
    email.hidden = kind.value !== "email";
    group.hidden = kind.value !== "team" && kind.value !== "organization";
    level.hidden = kind.value === "everyone";
  };
  kind.onchange = sync;
  sync();
  const grantForm = form([kind, email, group, level], "Grant", async (values) => {
    let to = { kind: values.kind };
    if (values.kind === "email") to = { kind: "email", value: values.email };
    if (values.kind === "team" || values.kind === "organization") {
      const [groupKind, value] = (values.group ?? "").split(":");
      if (groupKind !== values.kind) throw new Error(`choose a ${values.kind} from the list`);
      to = { kind: values.kind, value };
    }
    await call("grantNote", { id, to, level: values.kind === "everyone" ? "read" : values.level });
    flash("Granted.");
    refresh();
  }, "row");

  const links = el(
    "ul",
    { className: "list" },
    ...access.links.map((l) =>
      el(
        "li",
        {},
        `A ${l.level} link${l.expiresAt ? `, until ${when(l.expiresAt)}` : ""} `,
        button(
          "Revoke",
          attempt(async () => {
            await call("revokeLink", { id, link: l.id });
            refresh();
          }),
        ),
      ),
    ),
  );
  const linkForm = form([select("level", [["read", "read"], ["create", "create"], ["write", "write"]])], "Make a link", async ({ level: chosen }) => {
    const { path } = await call("linkNote", { id, level: chosen });
    const url = new URL(path, location.origin).toString();
    await navigator.clipboard?.writeText(url).catch(() => {});
    flash(`Link copied: ${url}`);
    refresh();
  }, "row");

  const inherit = el("input", { type: "checkbox", checked: access.inherits, disabled: !access.parent });
  inherit.onchange = attempt(async () => {
    await call("inheritNote", { id, inherit: inherit.checked });
    refresh();
  });

  const destinations = [["personal", "My own notes"], ...orgs.map((o) => [`organization:${o.id}`, `Organization: ${o.name}`]), ...teams.map((t) => [`team:${t.id}`, `Team: ${t.org.name} / ${t.name}`])];
  const moveForm = form([select("to", destinations)], "Move", async ({ to }) => {
    const [where, target] = to.split(":");
    await call("moveNote", { id, to: where === "personal" ? { kind: "personal" } : { kind: where, id: target } });
    flash("Moved.");
    refresh();
  }, "row");

  return section(
    "Permissions",
    el("p", { className: "muted", textContent: "Each principal counts its nearest grant up the chain of points this note inherits from; the highest across principals wins. Organization admins always manage notes inside their organization." }),
    el("h3", { textContent: "Grants" }),
    access.grants.length ? grants : empty("No grants."),
    grantForm,
    el("h3", { textContent: "Links" }),
    access.links.length ? links : empty("No links. A link gives its level on this note only, to anyone holding it, signed in or not."),
    linkForm,
    el("h3", { textContent: "Inheritance" }),
    el("label", {}, inherit, access.parent ? " Also use the grants of where this note sits" : " Personal notes sit nowhere, so there is nothing to inherit"),
    el("h3", { textContent: "Place" }),
    moveForm,
  );
}

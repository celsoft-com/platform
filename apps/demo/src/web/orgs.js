import { live } from "@celsoft/platform/live";
import { noteRow } from "./notes.js";
import { attempt, button, el, empty, flash, form, input, link, request, section, select, when } from "./ui.js";

// Organizations and teams: the platform's own, through /api/platform/, with notes in each and a
// live room named after the organization's or team's control point.

const api = "/api/platform";

export async function orgsPage(call) {
  const orgs = await call("listMyOrganizations", {});
  return el(
    "div",
    {},
    el("h1", { textContent: "Organizations" }),
    section(
      "Yours",
      orgs.length ? el("ul", { className: "list" }, ...orgs.map((o) => el("li", {}, link(o.name, `#/orgs/${o.id}`)))) : empty("You belong to none yet. Create one, or accept an invitation."),
    ),
    section(
      "New organization",
      form([input("name", { placeholder: "Name", required: true, maxLength: 60 })], "Create", async ({ name }) => {
        const org = await call("createOrganization", { name });
        location.hash = `#/orgs/${org.id}`;
      }, "row"),
    ),
  );
}

// Notes in an organization or a team, with presence and typing from its room.
function notesSection(title, roomName, list, add, ctx) {
  const here = el("p", { className: "muted" });
  const typing = el("p", { className: "muted" });
  let typingTimer;
  let lastTyping = 0;
  const room = live(roomName, {
    onMessage(data, { from }) {
      if (data.type === "note") list.prepend(noteRow(data.note));
      if (data.type === "typing" && from) {
        typing.textContent = `${from.name} is typing`;
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => (typing.textContent = ""), 3000);
      }
    },
    onPresence(people) {
      here.textContent = `Here now: ${people.map((p) => p.name).join(", ")}`;
    },
  });
  ctx.onLeave(() => room.close());
  const body = el("textarea", { name: "body", placeholder: "Write a note everyone here can read", required: true, maxLength: 10000 });
  body.addEventListener("input", () => {
    if (Date.now() - lastTyping < 2000) return;
    lastTyping = Date.now();
    room.send({ type: "typing" });
  });
  const write = form([body], "Add note", async ({ body: text }) => {
    const note = await add(text);
    if (!list.querySelector(`a[href="#/notes/${note.id}"]`)) list.prepend(noteRow(note));
  });
  return section(title, here, add ? write : null, typing, list);
}

export async function orgPage(call, id, ctx) {
  let org;
  try {
    org = await request(`${api}/organizations/${id}`);
  } catch {
    return el("div", {}, el("h1", { textContent: "Not found" }), empty("This organization does not exist, or you do not belong to it."));
  }
  const [members, teams, notes] = await Promise.all([request(`${api}/organizations/${id}/members`), request(`${api}/organizations/${id}/teams`), call("listOrganizationNotes", { organization: id })]);
  const admins = teams.find((t) => t.admins);
  const amAdmin = members.some((m) => m.userId === ctx.me.id && m.admin);
  const refresh = () => ctx.rerender();

  const list = el("ul", { className: "list" }, ...notes.map((n) => noteRow(n)));
  const page = el(
    "div",
    {},
    el("h1", { textContent: org.name }),
    el("p", { className: "muted", textContent: amAdmin ? "You are an admin here: you manage everything in this organization." : "You are a member here." }),
    notesSection("Organization notes", `organization:${id}`, list, (body) => call("addOrganizationNote", { organization: id, body }), ctx),
  );

  page.append(
    section(
      "Teams",
      el(
        "ul",
        { className: "list" },
        ...teams.map((t) => el("li", {}, link(t.name, `#/teams/${t.id}`), t.admins ? el("span", { className: "tag", textContent: "manages everything here" }) : null)),
      ),
      form([input("name", { placeholder: "New team name", required: true, maxLength: 100 })], "Create team", async ({ name }) => {
        const team = await request(`${api}/organizations/${id}/teams`, { body: { name } });
        location.hash = `#/teams/${team.id}`;
      }, "row"),
    ),
  );

  const memberRows = members.map((m) =>
    el(
      "tr",
      {},
      el("td", { textContent: m.name }),
      el("td", { textContent: m.email }),
      el("td", {}, m.admin ? el("span", { className: "tag", textContent: "admin" }) : ""),
      el(
        "td",
        {},
        amAdmin && admins && !m.admin
          ? button(
              "Make admin",
              attempt(async () => {
                await request(`${api}/teams/${admins.id}/members`, { body: { user: m.userId } });
                refresh();
              }),
            )
          : null,
        amAdmin && admins && m.admin
          ? button(
              "Remove admin",
              attempt(async () => {
                await request(`${api}/teams/${admins.id}/members/${m.userId}`, { method: "DELETE" });
                refresh();
              }),
            )
          : null,
        amAdmin && m.userId !== ctx.me.id
          ? button(
              "Remove",
              attempt(async () => {
                if (!confirm(`Remove ${m.name}?`)) return;
                await request(`${api}/organizations/${id}/members/${m.userId}`, { method: "DELETE" });
                refresh();
              }),
              { className: "danger" },
            )
          : null,
      ),
    ),
  );
  page.append(section("Members", el("table", {}, el("tbody", {}, ...memberRows))));

  if (amAdmin) {
    const invitations = await request(`${api}/organizations/${id}/invitations`);
    page.append(
      section(
        "Invitations",
        form(
          [input("email", { type: "email", placeholder: "Their email", required: true }), select("team", [["", "No team"], ...teams.filter((t) => !t.admins).map((t) => [t.id, `Also join ${t.name}`])])],
          "Invite",
          async ({ email, team }) => {
            await request(`${api}/organizations/${id}/invitations`, { body: { email, ...(team && { team }) } });
            flash(`Invited ${email}; they get an email, and see it under Invitations once their address is confirmed.`);
            refresh();
          },
          "row",
        ),
        invitations.length
          ? el(
              "ul",
              { className: "list" },
              ...invitations.map((i) =>
                el(
                  "li",
                  {},
                  `${i.email}, until ${when(i.expiresAt)} `,
                  button(
                    "Revoke",
                    attempt(async () => {
                      await request(`${api}/organizations/${id}/invitations/${i.id}`, { method: "DELETE" });
                      refresh();
                    }),
                  ),
                ),
              ),
            )
          : empty("No pending invitations."),
      ),
    );
  }

  page.append(
    section(
      "Settings",
      amAdmin
        ? form([input("name", { value: org.name, required: true, maxLength: 100 })], "Rename", async ({ name }) => {
            await request(`${api}/organizations/${id}`, { body: { name }, method: "PATCH" });
            refresh();
          }, "row")
        : null,
      el(
        "div",
        { className: "row" },
        button(
          "Leave organization",
          attempt(async () => {
            if (!confirm(`Leave ${org.name}?`)) return;
            await request(`${api}/organizations/${id}/members/${ctx.me.id}`, { method: "DELETE" });
            location.hash = "#/orgs";
          }),
        ),
        amAdmin
          ? button(
              "Delete organization",
              attempt(async () => {
                if (!confirm(`Delete ${org.name}, with all its teams and notes?`)) return;
                await request(`${api}/organizations/${id}`, { method: "DELETE" });
                location.hash = "#/orgs";
              }),
              { className: "danger" },
            )
          : null,
      ),
    ),
  );
  return page;
}

export async function teamPage(call, id, ctx) {
  let team;
  try {
    team = await request(`${api}/teams/${id}`);
  } catch {
    return el("div", {}, el("h1", { textContent: "Not found" }), empty("This team does not exist, or you cannot see it."));
  }
  const [org, teamMembers, orgMembers] = await Promise.all([
    request(`${api}/organizations/${team.organizationId}`),
    request(`${api}/teams/${id}/members`),
    request(`${api}/organizations/${team.organizationId}/members`).catch(() => []),
  ]);
  const refresh = () => ctx.rerender();
  const page = el(
    "div",
    {},
    el("h1", {}, link(org.name, `#/orgs/${org.id}`), ` / ${team.name}`),
    el("p", { className: "muted", textContent: team.admins ? "The Admins team: its members manage everything in the organization." : "Team notes are readable by the team and the organization's admins." }),
  );

  if (!team.admins) {
    let notes;
    try {
      notes = await call("listTeamNotes", { team: id });
    } catch (error) {
      notes = null;
      page.append(section("Team notes", empty(`You cannot read this team's notes (${error.message}).`)));
    }
    if (notes) {
      const list = el("ul", { className: "list" }, ...notes.map((n) => noteRow(n)));
      page.append(notesSection("Team notes", `team:${id}`, list, (body) => call("addTeamNote", { team: id, body }), ctx));
    }
  }

  const outside = orgMembers.filter((m) => !teamMembers.some((t) => t.userId === m.userId));
  page.append(
    section(
      "Members",
      teamMembers.length
        ? el(
            "ul",
            { className: "list" },
            ...teamMembers.map((m) =>
              el(
                "li",
                {},
                `${m.name} <${m.email}> `,
                m.userId !== ctx.me.id
                  ? button(
                      "Remove",
                      attempt(async () => {
                        await request(`${api}/teams/${id}/members/${m.userId}`, { method: "DELETE" });
                        refresh();
                      }),
                    )
                  : null,
              ),
            ),
          )
        : empty("No members yet."),
      outside.length
        ? form([select("user", outside.map((m) => [m.userId, `${m.name} <${m.email}>`]))], "Add to team", async ({ user }) => {
            await request(`${api}/teams/${id}/members`, { body: { user } });
            refresh();
          }, "row")
        : null,
    ),
  );

  page.append(
    section(
      "Settings",
      team.admins
        ? null
        : form([input("name", { value: team.name, required: true, maxLength: 100 })], "Rename", async ({ name }) => {
            await request(`${api}/teams/${id}`, { body: { name }, method: "PATCH" });
            refresh();
          }, "row"),
      el(
        "div",
        { className: "row" },
        teamMembers.some((m) => m.userId === ctx.me.id)
          ? button(
              "Leave team",
              attempt(async () => {
                await request(`${api}/teams/${id}/members/${ctx.me.id}`, { method: "DELETE" });
                refresh();
              }),
            )
          : null,
        team.admins
          ? null
          : button(
              "Delete team",
              attempt(async () => {
                if (!confirm(`Delete ${team.name} and its notes?`)) return;
                await request(`${api}/teams/${id}`, { method: "DELETE" });
                location.hash = `#/orgs/${org.id}`;
              }),
              { className: "danger" },
            ),
      ),
    ),
  );
  return page;
}

export async function invitationsPage(ctx) {
  const invitations = await request(`${api}/invitations`);
  return el(
    "div",
    {},
    el("h1", { textContent: "Invitations" }),
    el("p", { className: "muted", textContent: "Invitations sent to your confirmed email address." }),
    section(
      "Pending",
      invitations.length
        ? el(
            "ul",
            { className: "list" },
            ...invitations.map((i) =>
              el(
                "li",
                {},
                el("strong", { textContent: i.organization }),
                i.team ? `, team ${i.team}` : "",
                `, from ${i.invitedBy ?? "someone"}, until ${when(i.expiresAt)} `,
                button(
                  "Accept",
                  attempt(async () => {
                    const { organizationId } = await request(`${api}/invitations/${i.id}/accept`, { body: {} });
                    await ctx.refreshNav();
                    location.hash = `#/orgs/${organizationId}`;
                  }),
                ),
                button(
                  "Decline",
                  attempt(async () => {
                    await request(`${api}/invitations/${i.id}`, { method: "DELETE" });
                    await ctx.refreshNav();
                    ctx.rerender();
                  }),
                ),
              ),
            ),
          )
        : empty(ctx.me.emailVerified ? "No invitations." : "Confirm your email address in Settings to see invitations sent to it."),
    ),
  );
}

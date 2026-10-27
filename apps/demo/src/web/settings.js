import { attempt, button, el, empty, flash, form, input, request, section, when } from "./ui.js";

// The signed-in person's account, through Better Auth's own routes under /api/auth/.

export async function settingsPage(ctx) {
  const sessions = await request("/api/auth/list-sessions").catch(() => []);
  const current = ctx.session.session.token;
  return el(
    "div",
    {},
    el("h1", { textContent: "Settings" }),
    section(
      "Profile",
      form([el("label", {}, "Name ", input("name", { value: ctx.me.name, required: true, maxLength: 100 }))], "Save", async ({ name }) => {
        await request("/api/auth/update-user", { body: { name } });
        flash("Saved.");
        await ctx.refreshNav();
        ctx.rerender();
      }, "row"),
    ),
    section(
      "Email",
      el("p", {}, ctx.me.email, " ", el("span", { className: "tag", textContent: ctx.me.emailVerified ? "confirmed" : "not confirmed" })),
      ctx.me.emailVerified
        ? empty("Grants to your address and invitations sent to it reach you.")
        : el(
            "div",
            {},
            empty("Grants to your address and invitations sent to it reach you once it is confirmed."),
            button(
              "Send a confirmation email",
              attempt(async () => {
                await request("/api/auth/send-verification-email", { body: { email: ctx.me.email, callbackURL: "/#/settings" } });
                flash("Sent; open the link in it.");
              }),
            ),
          ),
    ),
    section(
      "Password",
      form(
        [
          input("currentPassword", { type: "password", placeholder: "Current password", required: true, autocomplete: "current-password" }),
          input("newPassword", { type: "password", placeholder: "New password, 8 characters or more", required: true, minLength: 8, autocomplete: "new-password" }),
        ],
        "Change password",
        async ({ currentPassword, newPassword }) => {
          await request("/api/auth/change-password", { body: { currentPassword, newPassword, revokeOtherSessions: true } });
          flash("Changed; your other sessions are signed out.");
          ctx.rerender();
        },
      ),
      el("p", {}, el("a", { href: "/forgot", textContent: "Forgot it? Reset it by email." })),
    ),
    section(
      "Sessions",
      sessions.length
        ? el(
            "ul",
            { className: "list" },
            ...sessions.map((s) =>
              el("li", {}, `${s.userAgent ?? "Unknown browser"}, since ${when(s.createdAt)}`, s.token === current ? el("span", { className: "tag", textContent: "this one" }) : null),
            ),
          )
        : empty("No sessions listed."),
      el(
        "div",
        { className: "row" },
        button(
          "Sign out other sessions",
          attempt(async () => {
            await request("/api/auth/revoke-other-sessions", { body: {} });
            flash("Signed out everywhere else.");
            ctx.rerender();
          }),
        ),
        button("Sign out", attempt(ctx.signOut)),
      ),
    ),
  );
}

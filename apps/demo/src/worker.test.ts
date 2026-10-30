import { organizationPoint } from "@celsoft/platform";
import { EndpointError } from "@celsoft/platform/client";
import { testApp } from "@celsoft/platform/testing";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import app from "./worker";

// The demo tested the way an app tests itself: the platform's real runtime on a local database.
const t = await testApp(app, { dir: fileURLToPath(new URL("..", import.meta.url)) });
afterAll(() => t.close());

describe("demo", () => {
  it("lets the owner make an organization and add notes its members see live", async () => {
    const owner = await t.signUp("owner@example.com");
    const org = await t.as(owner).call("createOrganization", { name: "Acme" });
    expect(await t.as(owner).call("listMyOrganizations", {})).toEqual([{ id: org.id, name: "Acme" }]);
    const note = await t.as(owner).call("addOrganizationNote", { organization: org.id, body: "hello" });
    expect(await t.as(owner).call("listOrganizationNotes", { organization: org.id })).toMatchObject([{ id: note.id, body: "hello" }]);
    expect(t.published.at(-1)).toMatchObject({ room: organizationPoint(org.id), message: { type: "note", note: { body: "hello" } } });
    expect(t.emails.map((e) => e.to)).toContain("owner@example.com");
    expect(await t.as(owner).call("about", {})).toEqual({ level: "manage" });
  });

  it("keeps one person's organization from another", async () => {
    const owner = await t.signUp("first@example.com");
    const stranger = await t.signUp("stranger@example.com");
    const org = await t.as(owner).call("createOrganization", { name: "Private" });
    const refused = await t.as(stranger).call("listOrganizationNotes", { organization: org.id }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(EndpointError);
    expect((refused as EndpointError).status).toBe(404);
  });

  it("lets everyone else only read the about point", async () => {
    const someone = await t.signUp("someone@example.com");
    expect(await t.call("about", {})).toEqual({ level: "read" });
    expect(await t.as(someone).call("about", {})).toEqual({ level: "read" });
  });

  it("holds an API token to its cap", async () => {
    const person = await t.signUp("scripter@example.com");
    const made = await t.as(person).fetch("/api/auth/api-key/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "script", metadata: { cap: "read" } }) });
    const { key } = (await made.json()) as { key: string };
    expect(await t.as({ token: key }).call("listMyOrganizations", {})).toEqual([]);
    const refused = await t.as({ token: key }).call("createOrganization", { name: "Nope" }).catch((e: unknown) => e);
    expect((refused as EndpointError).status).toBe(403);
  });
});

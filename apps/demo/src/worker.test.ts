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

  it("adds a note with an attachment through an upload endpoint, and serves the file back", async () => {
    const writer = await t.signUp("writer@example.com");
    const note = await t.as(writer).call("addNote", { body: "with a file", file: new File(["attached"], "a.txt", { type: "text/plain" }) });
    expect(note).toMatchObject({ body: "with a file", attachmentName: "a.txt" });
    expect(await (await t.as(writer).fetch(`/api/public/notes/${note.id}/attachment`)).text()).toBe("attached");
    const tooBig = await t.as(writer).call("addNote", { body: "big", file: new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.bin") }).catch((e: unknown) => e);
    expect((tooBig as EndpointError).status).toBe(400);
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

  it("searches a person's bookmarks with JSONPath, by value and type", async () => {
    const reader = await t.signUp("reader@example.com");
    const bookmarks = [
      { url: "https://a.example", title: "A", stars: 4, tags: ["news"] },
      { url: "https://b.example", title: "B", stars: 5 },
      { url: "https://c.example", title: "C", stars: 4 },
    ];
    expect(await t.as(reader).call("saveBookmarks", { bookmarks })).toEqual({ saved: 3 });
    expect(await t.as(reader).call("searchBookmarks", { where: "$[?@.stars == 4].title" })).toEqual({ items: [{ path: "$[0]['title']", value: "A" }, { path: "$[2]['title']", value: "C" }], total: 2 });
    expect(await t.as(reader).call("searchBookmarks", { where: "$[?@.stars == '4']" })).toEqual({ items: [], total: 0 });
    expect(await t.as(reader).call("searchBookmarks", { where: "$[*]", limit: 1, offset: 1 })).toEqual({ items: [{ path: "$[1]", value: bookmarks[1] }], total: 3 });
    expect(await t.as(await t.signUp("other@example.com")).call("searchBookmarks", {})).toEqual({ items: [], total: 0 });
    const refused = await t.as(reader).call("searchBookmarks", { where: "$[?@.stars = 4]" }).catch((e: unknown) => e);
    expect((refused as EndpointError).status).toBe(400);
  });

  it("holds an API token to its cap", async () => {
    const person = await t.signUp("scripter@example.com");
    const made = await t.as(person).fetch("/api/auth/api-key/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "script", metadata: { cap: "read" } }) });
    const { key } = (await made.json()) as { key: string };
    expect(await t.as({ token: key }).call("listMyOrganizations", {})).toEqual([]);
    const refused = await t.as({ token: key }).call("createOrganization", { name: "Nope" }).catch((e: unknown) => e);
    expect((refused as EndpointError).status).toBe(403);
    expect(await t.as({ token: key }).call("searchBookmarks", {})).toEqual({ items: [], total: 0 });
    const save = await t.as({ token: key }).call("saveBookmarks", { bookmarks: [] }).catch((e: unknown) => e);
    expect((save as EndpointError).status).toBe(403);
  });
});

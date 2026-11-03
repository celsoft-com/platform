import { testApp } from "@celsoft/platform/testing";
import { afterAll, expect, it } from "vitest";
import { items } from "./schema";
import app from "./worker";

// The app's real runtime on a database of its own; `npm test` runs it.
const t = await testApp(app);
afterAll(() => t.close());

it("lists the newest items", async () => {
  await t.db.insert(items).values({ name: "first" });
  expect(await t.call("listItems", {})).toMatchObject([{ name: "first" }]);
});

it("serves the frontend's files before the Worker, as a deploy does", async () => {
  const home = await t.fetch("/");
  expect(home.status).toBe(200);
  expect(home.headers.get("content-type")).toContain("text/html");
  expect(await home.text()).toContain("<h1>");
});

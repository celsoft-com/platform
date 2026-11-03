import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { renderScreen, SCREEN_PATHS } from "./screens.js";

// Each screen rendered as the browser gets it, its own script run in a DOM, with the network
// recorded instead of reached.
async function open(path: (typeof SCREEN_PATHS)[number], query = "") {
  const html = await renderScreen(path, "Notes", undefined).text();
  const window = new Window({ url: `https://app.test${path}${query}`, settings: { enableJavaScriptEvaluation: true } });
  const posts: { url: string; body: unknown }[] = [];
  const errors: unknown[] = [];
  window.addEventListener("error", (event) => errors.push((event as unknown as { error: unknown }).error));
  window.fetch = (async (url: string, init?: { body?: string }) => {
    posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new window.Response(JSON.stringify({ url: "https://client.example/cb?code=c", redirect: true, client_name: "Claude" }), { headers: { "content-type": "application/json" } });
  }) as never;
  window.document.write(html);
  await window.happyDOM.waitUntilComplete();
  return { window, document: window.document, posts, errors };
}

describe("screens", () => {
  it("run their scripts without an error, carrying the query onto links to other screens", async () => {
    for (const path of SCREEN_PATHS) {
      const { errors, window, document } = await open(path, "?next=%2Fadmin");
      expect(errors, path).toEqual([]);
      for (const a of document.querySelectorAll("a[data-carry]")) expect(a.getAttribute("href"), path).toContain("next=%2Fadmin");
      await window.happyDOM.close();
    }
  });

  it("consent posts Allow and Deny to the OAuth server, keeping the signed query", async () => {
    const query = "?client_id=abc&scope=openid&sig=s1&ba_param=client_id";
    const allow = await open("/consent", query);
    allow.document.querySelector("form")!.dispatchEvent(new allow.window.Event("submit", { cancelable: true }));
    await allow.window.happyDOM.waitUntilComplete();
    expect(allow.posts.find((p) => p.url.endsWith("/api/auth/oauth2/consent"))?.body).toMatchObject({ accept: true });
    const deny = await open("/consent", query);
    (deny.document.querySelector('[data-action="deny"]') as unknown as { click(): void }).click();
    await deny.window.happyDOM.waitUntilComplete();
    expect(deny.posts.find((p) => p.url.endsWith("/api/auth/oauth2/consent"))?.body).toMatchObject({ accept: false });
    expect(deny.document.querySelector('[data-action="deny"]')!.getAttribute("href")).toBe("#deny");
  });
});

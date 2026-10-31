import { describe, expect, it } from "vitest";
import { isCrossSiteForm } from "./guard.js";

const form = (path: string, origin?: string) => {
  const request = new Request(`https://app.test${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(origin && { origin }) }, body: "a=1" });
  return isCrossSiteForm(request, new URL(request.url));
};

describe("cross-site forms", () => {
  it("refuses a form from another site or with no origin", () => {
    expect(form("/api/notes", "https://evil.example")).toBe(true);
    expect(form("/api/notes")).toBe(true);
    expect(form("/api/notes", "https://app.test")).toBe(false);
  });

  it("lets a script with an API token post a form, such as an upload, with no origin", () => {
    const request = new Request("https://app.test/api/upload", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", authorization: "Bearer t" }, body: "" });
    expect(isCrossSiteForm(request, new URL(request.url))).toBe(false);
  });

  it("lets AI clients post to the OAuth token endpoints, which never use cookies", () => {
    expect(form("/api/auth/oauth2/token")).toBe(false);
    expect(form("/api/auth/oauth2/revoke")).toBe(false);
    expect(form("/api/auth/oauth2/authorize")).toBe(true);
  });
});

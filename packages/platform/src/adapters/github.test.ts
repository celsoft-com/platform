import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GhCli, repoFromUrl } from "./github.js";

const repo = async (remotes: Record<string, string>) => {
  const dir = await mkdtemp(join(tmpdir(), "gh-target-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, url] of Object.entries(remotes)) execFileSync("git", ["remote", "add", name, url], { cwd: dir });
  return dir;
};

describe("GitHub target", () => {
  it("reads owner/name from https, SSH and SSH-alias remote URLs", () => {
    for (const url of ["https://github.com/acme/site.git", "https://github.com/acme/site", "git@github.com:acme/site.git", "git@github.com-acme:acme/site.git", "ssh://git@github.com/acme/site.git/"]) {
      expect(repoFromUrl(url), url).toBe("acme/site");
    }
  });

  it("names origin, never the template a copy was made from, whatever gh's default", async () => {
    const dir = await repo({ upstream: "https://github.com/celsoft-com/pages.git", origin: "git@github.com-me:me/pages-family.git" });
    expect(await new GhCli(dir, {}).target()).toBe("me/pages-family");
  });

  it("takes the only remote, refuses to guess between several without origin, and prefers GITHUB_REPOSITORY in CI", async () => {
    expect(await new GhCli(await repo({ mine: "https://github.com/me/app.git" }), {}).target()).toBe("me/app");
    await expect(new GhCli(await repo({ a: "https://github.com/x/a.git", b: "https://github.com/x/b.git" }), {}).target()).rejects.toThrow(/none is origin/);
    expect(await new GhCli(await repo({ upstream: "https://github.com/x/t.git" }), { GITHUB_REPOSITORY: "me/ci" }).target()).toBe("me/ci");
  });
});

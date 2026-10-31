import { describe, expect, it } from "vitest";
import { buildInfo, buildVars } from "./build-info.js";
import { readDeploy } from "./runtime/deploy.js";

describe("buildInfo", () => {
  it("takes a pull request's head and branch from GitHub over git", () => {
    const info = buildInfo(process.cwd(), "preview", { GITHUB_SHA: "merge", GITHUB_HEAD_REF: "feat/x", GITHUB_REF_NAME: "7/merge" }, "head");
    expect(info).toMatchObject({ commit: "head", branch: "feat/x", target: "preview" });
  });

  it("falls back to git outside CI", () => {
    const info = buildInfo(process.cwd(), "dev", {});
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads back on the Worker as app.deploy", () => {
    const info = { commit: "abc", branch: "main", builtAt: "2026-10-31T00:00:00.000Z", target: "prod" as const };
    expect(readDeploy(buildVars(info))).toEqual({ commit: "abc", branch: "main", builtAt: new Date(info.builtAt), target: "prod" });
    expect(readDeploy({})).toEqual({ commit: null, branch: null, builtAt: null, target: null });
  });
});

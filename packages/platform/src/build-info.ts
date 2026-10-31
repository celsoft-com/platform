import { execFileSync } from "node:child_process";
import type { DeployTarget } from "./runtime/deploy.js";

export interface BuildInfo {
  commit: string;
  branch: string;
  builtAt: string;
  target: DeployTarget;
}

// What is being built, from GitHub's variables in CI, where a pull request's checkout has no branch,
// and from git locally; empty when neither knows.
export function buildInfo(appDir: string, target: DeployTarget, env: NodeJS.ProcessEnv = process.env, sha?: string): BuildInfo {
  const git = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: appDir, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  return {
    commit: sha || env.GITHUB_SHA || git(["rev-parse", "HEAD"]),
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || git(["branch", "--show-current"]),
    builtAt: new Date().toISOString(),
    target,
  };
}

// The same names for the app's build script and its Worker, so a build and a request read one stamp.
export function buildVars(info: BuildInfo): Record<string, string> {
  return { PLATFORM_COMMIT: info.commit, PLATFORM_BRANCH: info.branch, PLATFORM_BUILT_AT: info.builtAt, PLATFORM_TARGET: info.target };
}

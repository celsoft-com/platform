import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PackageManager = "pnpm" | "npm";

// pnpm when the repo has a pnpm lockfile, else npm; read from the repo root, where a workspace's
// lockfile sits, never from an app folder inside it.
export async function packageManager(repoRoot: string): Promise<PackageManager> {
  return (await readFile(join(repoRoot, "pnpm-lock.yaml"), "utf8").then(() => true, () => false)) ? "pnpm" : "npm";
}

// The app's own package.json scripts, which the platform runs by convention: `build` before a
// deploy, `dev` beside the local Worker.
export async function packageScripts(appDir: string): Promise<Record<string, string>> {
  const text = await readFile(join(appDir, "package.json"), "utf8").catch(() => "{}");
  return ((JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {}) as Record<string, string>;
}

export function startScript(appDir: string, manager: PackageManager, script: string, env: Record<string, string> = {}): ChildProcess {
  return spawn(manager, ["run", script], { cwd: appDir, stdio: "inherit", env: { ...process.env, ...env } });
}

export function runScript(appDir: string, manager: PackageManager, script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = startScript(appDir, manager, script);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`the app's \`${script}\` script failed with code ${code}; nothing was deployed`))));
  });
}

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PackageManager = "pnpm" | "npm";

// The app's own package.json scripts, which the platform runs by convention: `build` before a
// deploy, a preview or `dev`, `dev` beside the local Worker.
export async function packageScripts(appDir: string): Promise<Record<string, string>> {
  const text = await readFile(join(appDir, "package.json"), "utf8").catch(() => "{}");
  return ((JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {}) as Record<string, string>;
}

export function startScript(appDir: string, manager: PackageManager, script: string, env: Record<string, string> = {}): ChildProcess {
  return spawn(manager, ["run", script], { cwd: appDir, stdio: "inherit", env: { ...process.env, ...env } });
}

export function runScript(appDir: string, manager: PackageManager, script: string, env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = startScript(appDir, manager, script, env);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`the app's \`${script}\` script failed with code ${code}; nothing was deployed or started`))));
  });
}

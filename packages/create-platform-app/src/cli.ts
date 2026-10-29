#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// The one way to start an app is the package and its skills; this runs those steps in a new folder.
const usage = `usage: npm create @celsoft/platform-app <name> -- [--hostname <host>] [--neon-project <id>]

The same as running these in a new folder:

  npm install @celsoft/platform
  npx @celsoft/platform skills
  npx @celsoft/platform new --name <name> [--hostname <host>] [--neon-project <id>]`;

async function main([name, ...rest]: string[]): Promise<void> {
  if (!name || name.startsWith("-")) {
    console.log(usage);
    return;
  }
  const target = resolve(name);
  if ((await stat(target).catch(() => undefined)) && (await readdir(target)).length > 0) throw new Error(`${target} already exists and is not empty`);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "package.json"), `${JSON.stringify({ name, private: true, type: "module" }, null, 2)}\n`);

  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: target, stdio: "inherit" });
  run("npm", ["install", `@celsoft/platform@^${version}`]);
  run("npx", ["--no-install", "@celsoft/platform", "skills"]);
  run("npx", ["--no-install", "@celsoft/platform", "new", "--name", name, ...rest]);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

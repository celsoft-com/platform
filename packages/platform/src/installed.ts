import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PACKAGE = "@celsoft/platform";

async function json(path: string): Promise<{ version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined> {
  return readFile(path, "utf8").then((text) => JSON.parse(text), () => undefined);
}

// npx runs whatever version it finds or downloads, which is not always the one the app installed,
// so an app that depends on the package is only run by its own copy.
export async function installedMismatch(appDir: string, running: string): Promise<string | undefined> {
  const app = await json(join(appDir, "package.json"));
  if (!app?.dependencies?.[PACKAGE] && !app?.devDependencies?.[PACKAGE]) return undefined;
  for (let dir = appDir; ; dir = dirname(dir)) {
    const installed = await json(join(dir, "node_modules", PACKAGE, "package.json"));
    if (installed?.version) {
      return installed.version === running ? undefined : `this is ${PACKAGE} ${running}, but the app has ${installed.version} installed; run \`npm install\` in the app's folder, then run the command from there, so npx uses the app's own copy`;
    }
    if (dirname(dir) === dir) return `the app depends on ${PACKAGE}, but it is not installed; run \`npm install\` in the app's folder, then run this again`;
  }
}

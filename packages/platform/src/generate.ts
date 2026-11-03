import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parse } from "jsonc-parser";
import { readConfigText } from "./config.js";
import type { StaticPoint } from "./runtime/access.js";
import { apiRoutes, type Endpoint } from "./runtime/endpoints.js";
import { packageManagerAbove, packageScripts, runScript } from "./scripts.js";
import { ensureIgnored, installSkills } from "./skills.js";

// Everything the package writes into an app lives here, gitignored: files the app's code may
// import, and the deploy's temporary files.
export const GENERATED_DIR = ".platform";

export const generatedPath = (appDir: string, file: string) => join(appDir, GENERATED_DIR, file);

// Writes the generated files the app's code imports: today the browser client, whose routes come
// from the endpoints the Worker declares. It reads only `worker` from platform.jsonc, so it runs
// on install before any value platform.jsonc takes from the environment is set. Also returns the
// paths the Worker's pages claim, which the deploy routes to it.
export async function generate(appDir: string): Promise<{ files: string[]; pages: string[]; staticPoints: Record<string, StaticPoint> }> {
  const workerFile = workerPath(await readConfigText(appDir));
  // The app's own `generate` script writes modules the Worker imports, such as content built from
  // files, so they exist before the Worker is read here; the frontend's `build` runs after.
  const own = (await packageScripts(appDir)).generate;
  if (own !== undefined) {
    if (/\bplatform\s+generate\b/.test(own)) throw new Error("the app's `generate` script runs `platform generate`, which runs that script again; give it only the app's own steps");
    await runScript(appDir, await packageManagerAbove(appDir), "generate", "nothing was generated");
  }
  await mkdir(join(appDir, GENERATED_DIR), { recursive: true });
  await ensureIgnored(appDir, `${GENERATED_DIR}/`);
  const declared = await readApp(appDir, workerFile);
  const routes = apiRoutes(declared.endpoints);
  const worker = "../" + workerFile.replace(/^\.\//, "").replace(/\.ts$/, ".js");
  const table = Object.fromEntries(Object.entries(routes).map(([name, route]) => [name, [route.method, route.path]]));
  const client = [
    "// Written by @celsoft/platform from the Worker's endpoints; never edit or commit it.",
    'import { createCall } from "@celsoft/platform/client";',
    `import type app from ${JSON.stringify(worker)};`,
    "",
    `export const call = createCall<typeof app>(${JSON.stringify(table, null, 2)});`,
    "",
  ].join("\n");
  const file = generatedPath(appDir, "client.ts");
  await writeFile(file, client);
  return { files: [relative(appDir, file), ...(await installSkills(appDir))], pages: declared.pages, staticPoints: declared.staticPoints };
}

// Bundles the Worker for Node with its packages left as imports, then reads the endpoints, pages
// and static points its default export declares; nothing it would do on a request runs.
async function readApp(appDir: string, worker: string): Promise<{ endpoints: Record<string, Omit<Endpoint, "handler">>; pages: string[]; staticPoints: Record<string, StaticPoint> }> {
  const outfile = generatedPath(appDir, "endpoints-probe.mjs");
  await build({ entryPoints: [join(appDir, worker)], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "error" });
  try {
    const module = (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)) as {
      default?: { endpoints?: Record<string, Omit<Endpoint, "handler">>; pages?: string[]; staticPoints?: Record<string, StaticPoint> };
    };
    return { endpoints: module.default?.endpoints ?? {}, pages: module.default?.pages ?? [], staticPoints: module.default?.staticPoints ?? {} };
  } finally {
    await rm(outfile, { force: true });
  }
}

function workerPath(configText: string): string {
  const worker = (parse(configText, [], { allowTrailingComma: true }) as { worker?: unknown } | undefined)?.worker;
  if (typeof worker !== "string" || !worker) throw new Error("platform.jsonc has no `worker`, the path to the Worker's entry module");
  return worker;
}

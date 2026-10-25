import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { Config } from "./config.js";
import { apiRoutes, type Endpoint } from "./runtime/endpoints.js";

// Everything the package writes into an app lives here, gitignored: files the app's code may
// import, and the deploy's temporary files.
export const GENERATED_DIR = ".platform";

export const generatedPath = (appDir: string, file: string) => join(appDir, GENERATED_DIR, file);

// Writes the generated files the app's code imports: today the browser client, whose routes come
// from the endpoints the Worker declares.
export async function generate(appDir: string, config: Config): Promise<string[]> {
  await mkdir(join(appDir, GENERATED_DIR), { recursive: true });
  await ensureIgnored(appDir);
  const routes = apiRoutes(await readEndpoints(appDir, config.worker));
  const worker = "../" + config.worker.replace(/^\.\//, "").replace(/\.ts$/, ".js");
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
  return [relative(appDir, file)];
}

// Bundles the Worker for Node with its packages left as imports, then reads the endpoints its
// default export declares; nothing it would do on a request runs.
async function readEndpoints(appDir: string, worker: string): Promise<Record<string, Omit<Endpoint, "handler">>> {
  const outfile = generatedPath(appDir, "endpoints-probe.mjs");
  await build({ entryPoints: [join(appDir, worker)], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "error" });
  try {
    const module = (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)) as { default?: { endpoints?: Record<string, Omit<Endpoint, "handler">> } };
    return module.default?.endpoints ?? {};
  } finally {
    await rm(outfile, { force: true });
  }
}

async function ensureIgnored(appDir: string): Promise<void> {
  const gitignore = join(appDir, ".gitignore");
  const text = await readFile(gitignore, "utf8").catch(() => "");
  if (text.split(/\r?\n/).some((line) => [GENERATED_DIR, `${GENERATED_DIR}/`, `/${GENERATED_DIR}/`].includes(line.trim()))) return;
  await appendFile(gitignore, `${text && !text.endsWith("\n") ? "\n" : ""}${GENERATED_DIR}/\n`);
}

import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parse } from "jsonc-parser";
import { readConfigText } from "./config.js";
import type { StaticPoint } from "./runtime/access.js";
import { apiRoutes, type Endpoint } from "./runtime/endpoints.js";

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
  await mkdir(join(appDir, GENERATED_DIR), { recursive: true });
  await ensureIgnored(appDir);
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
  return { files: [relative(appDir, file), ...((await writeAgentsBlock(appDir)) ? ["AGENTS.md"] : [])], pages: declared.pages, staticPoints: declared.staticPoints };
}

const BLOCK_START = "<!-- @celsoft/platform:start -->";
const BLOCK_END = "<!-- @celsoft/platform:end -->";

// Points the app's agents at the skills the installed package ships, read from node_modules, so
// they always match the installed version. Only this block of AGENTS.md is the platform's.
export const AGENTS_BLOCK = `${BLOCK_START}
## @celsoft/platform

This app is built on @celsoft/platform. Before changing it, read the skills the installed version
ships, starting with \`node_modules/@celsoft/platform/skills/celsoft-platform/SKILL.md\`; every
skill is a \`SKILL.md\` under \`node_modules/@celsoft/platform/skills/\`. They match the installed
version, so read them again after an upgrade. This block is rewritten on install; edit outside it.
${BLOCK_END}`;

// True when AGENTS.md changed.
export async function writeAgentsBlock(appDir: string): Promise<boolean> {
  const file = join(appDir, "AGENTS.md");
  const text = await readFile(file, "utf8").catch(() => "");
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  const next =
    start >= 0 && end > start
      ? text.slice(0, start) + AGENTS_BLOCK + text.slice(end + BLOCK_END.length)
      : text
        ? `${text.replace(/\n*$/, "")}\n\n${AGENTS_BLOCK}\n`
        : `${AGENTS_BLOCK}\n`;
  if (next === text) return false;
  await writeFile(file, next);
  return true;
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

async function ensureIgnored(appDir: string): Promise<void> {
  const gitignore = join(appDir, ".gitignore");
  const text = await readFile(gitignore, "utf8").catch(() => "");
  if (text.split(/\r?\n/).some((line) => [GENERATED_DIR, `${GENERATED_DIR}/`, `/${GENERATED_DIR}/`].includes(line.trim()))) return;
  await appendFile(gitignore, `${text && !text.endsWith("\n") ? "\n" : ""}${GENERATED_DIR}/\n`);
}

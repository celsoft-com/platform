// The build machine's server. The instance drives it one step at a time over HTTP: the source,
// the build, the database migrations, the Worker bundle and the static files' upload. Everything
// here runs beside the app's own code, so the instance trusts nothing it says: it only ever holds
// what belongs to this one app.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const WORK = process.env.BUILDER_WORK ?? "/work";
const REPO = join(WORK, "repo");
const OUT = join(WORK, "out");
const TAIL = 200;

let app; // what /build found, for the steps after it
const log = [];

function note(line) {
  for (const part of String(line).split("\n")) {
    if (!part) continue;
    log.push(part);
    if (log.length > 5000) log.splice(0, log.length - 5000);
  }
}

class Failed extends Error {}

function sh(command, cwd, env = {}) {
  return capture(command, cwd, env).then(({ code }) => {
    if (code !== 0) throw new Failed(`\`${command}\` failed with code ${code}`);
  });
}

// Runs a command, logging it as written (a token is passed in env and named, never written out),
// and keeps its output for the caller.
function capture(command, cwd, env = {}) {
  note(`$ ${command}`);
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      note(chunk);
    });
    child.stderr.on("data", note);
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout: stdout.trim() }));
  });
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// The source arrives as GitHub's tarball, whose one top folder is dropped.
function receive(request) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xz", "--strip-components=1", "-C", REPO]);
    request.pipe(child.stdin);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Failed("the source archive could not be unpacked"))));
  });
}

const has = (dir, file) => existsSync(join(dir, file));

// The repo's package manager, from its lockfile, and the install that keeps to that lockfile.
function manager(root) {
  if (has(root, "pnpm-lock.yaml")) return { name: "pnpm", install: "pnpm install --frozen-lockfile" };
  if (has(root, "yarn.lock")) return { name: "yarn", install: "yarn install --immutable" };
  if (has(root, "bun.lock") || has(root, "bun.lockb")) return { name: "bun", install: "npx -y bun install --frozen-lockfile" };
  if (has(root, "package-lock.json")) return { name: "npm", install: "npm ci" };
  return { name: "npm", install: "npm install" };
}

// The framework the app installed, whatever its version; it knows how this app is built.
async function framework(appDir) {
  for (let dir = appDir; ; dir = dirname(dir)) {
    const pkg = join(dir, "node_modules", "@celsoft", "platform", "package.json");
    if (existsSync(pkg)) {
      const root = dirname(pkg);
      const load = (file) => import(pathToFileURL(join(root, "dist", file)).href);
      return { root, pkg, version: JSON.parse(await readFile(pkg, "utf8")).version, load };
    }
    if (dirname(dir) === dir) throw new Failed("the app does not install @celsoft/platform, so it cannot be built here; add it to the app's package.json dependencies");
  }
}

async function files(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/")).sort();
}

async function build(input) {
  const appDir = join(REPO, input.dir || ".");
  // The instance's reading of platform.jsonc, with the name and address it gave the app.
  await writeFile(join(appDir, "platform.jsonc"), input.config);
  const pm = manager(REPO);
  const scripts = JSON.parse(await readFile(join(appDir, "package.json"), "utf8").catch(() => "{}")).scripts ?? {};
  const install = input.install ?? pm.install;
  const buildCommand = input.build ?? (scripts.build ? `${pm.name} run build` : "");
  const testCommand = input.test ?? (scripts.test ? `${pm.name} run test` : "");
  note(`package manager: ${pm.name}`);
  if (install) await sh(install, REPO);

  const fw = await framework(appDir);
  note(`@celsoft/platform ${fw.version}`);
  const { parseConfig } = await fw.load("config.js");
  const config = parseConfig(input.config, "platform.jsonc");
  const { generate } = await fw.load("generate.js");
  const declared = await generate(appDir);
  if (buildCommand) await sh(buildCommand, appDir);
  if (testCommand) await sh(testCommand, appDir);

  let upToDate = true;
  let migrator;
  if (config.database) {
    const { DrizzleMigrator } = await fw.load("adapters/drizzle.js");
    migrator = new DrizzleMigrator(appDir, config);
    upToDate = await migrator.upToDate();
  }
  const { wranglerConfig } = await fw.load("wrangler-config.js");
  const wrangler = wranglerConfig({
    config,
    worker: config.name,
    hostname: config.hostname,
    accountId: "",
    hyperdriveId: config.database ? "hyperdrive" : undefined,
    vars: {},
    bucket: config.files ? "bucket" : undefined,
    pages: declared.pages,
  });
  app = { appDir, fw, config, declared, migrator, wrangler };
  return { framework: fw.version, manager: pm.name, upToDate, pages: declared.pages, staticPoints: Object.keys(declared.staticPoints ?? {}), wrangler };
}

async function migrate({ uri, forgetKeys }) {
  const { migrator, config, declared } = need();
  if (!migrator) return {};
  await migrator.migrate(uri);
  note("migrations applied");
  if (config.auth) {
    await migrator.prepareAccess(uri, declared.staticPoints ?? {});
    note("access triggers and static control points written");
  }
  await migrator.prepareTables(uri);
  note("page cache and redirect tables written");
  if (config.auth && forgetKeys) {
    await migrator.forgetSigningKeys(uri);
    note("signing keys this Worker cannot decrypt forgotten");
  }
  return {};
}

const TYPES = { ".js": "application/javascript+module", ".mjs": "application/javascript+module", ".cjs": "application/javascript", ".wasm": "application/wasm", ".txt": "text/plain", ".bin": "application/octet-stream", ".html": "text/plain", ".sql": "text/plain" };

// The Worker as Wrangler bundles it, written out instead of uploaded.
async function bundle() {
  const { appDir, fw, wrangler, config } = need();
  const generated = join(appDir, ".platform");
  await mkdir(generated, { recursive: true });
  const wc = await fw.load("wrangler-config.js");
  const staticFiles = wrangler.assets ? await files(join(generated, wrangler.assets.directory)) : [];
  await writeFile(join(generated, wc.ENTRY_FILE), wc.entryModule(config.worker, staticFiles));
  await writeFile(join(generated, wc.NO_KYSELY_FILE), wc.NO_KYSELY_MODULE);
  const configFile = join(generated, "wrangler.json");
  // A dry run bundles only; the account and the address are the instance's to set.
  const { account_id: _account, routes: _routes, ...local } = wrangler;
  await writeFile(configFile, JSON.stringify(local, null, 2));
  const wranglerBin = join(dirname(createRequire(fw.pkg).resolve("wrangler/package.json")), "bin", "wrangler.js");
  await rm(OUT, { recursive: true, force: true });
  await sh(`node ${JSON.stringify(wranglerBin)} deploy --dry-run --outdir ${OUT} --config ${JSON.stringify(configFile)}`, appDir);

  const modules = [];
  for (const name of await files(OUT)) {
    const type = TYPES[extname(name)];
    if (!type || name.endsWith(".map") || name === "README.md") continue;
    modules.push({ name, type, content: (await readFile(join(OUT, name))).toString("base64") });
  }
  const js = modules.filter((m) => m.type === "application/javascript+module").map((m) => m.name);
  const main = js.find((n) => n === "entry.js") ?? js.find((n) => n === "index.js") ?? js[0];
  if (!main) throw new Failed("Wrangler wrote no Worker module");

  const assets = { manifest: {}, headers: undefined, redirects: undefined };
  if (wrangler.assets) {
    const dir = join(generated, wrangler.assets.directory);
    app.assetsDir = dir;
    app.hashes = {};
    for (const name of await files(dir)) {
      if (name === "_headers") assets.headers = await readFile(join(dir, name), "utf8");
      else if (name === "_redirects") assets.redirects = await readFile(join(dir, name), "utf8");
      else if (name !== ".assetsignore" && name !== "_worker.js") {
        const content = await readFile(join(dir, name));
        const hash = createHash("sha256").update(content).digest("hex").slice(0, 32);
        assets.manifest[`/${name}`] = { hash, size: content.length };
        app.hashes[hash] = name;
      }
    }
  }
  return { main, modules, assets };
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".mjs": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain", ".xml": "application/xml", ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm", ".pdf": "application/pdf", ".map": "application/json" };

// Uploads the files Cloudflare asked for with the upload session's token, which reaches only this
// app's upload, and hands back the token that finishes it.
async function upload({ account, jwt, buckets }) {
  const { assetsDir, hashes } = need();
  let completion = jwt;
  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const name = hashes[hash];
      if (!name) throw new Failed(`Cloudflare asked for a file this build does not have (${hash})`);
      const content = (await readFile(join(assetsDir, name))).toString("base64");
      form.append(hash, new File([content], hash, { type: MIME[extname(name).toLowerCase()] ?? "application/octet-stream" }));
    }
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/assets/upload?base64=true`, { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: form });
    const result = await response.json().catch(() => undefined);
    if (!response.ok || !result?.success) throw new Failed(`Cloudflare refused the static files (${response.status}${result?.errors?.length ? `: ${result.errors.map((e) => e.message).join("; ")}` : ""})`);
    if (result.result?.jwt) completion = result.result.jwt;
  }
  note(`uploaded ${buckets.flat().length} static files`);
  return { jwt: completion };
}

// Git: cloning a source into an app's new repo, and merging a newer source into it. Only the
// instance's git machine does this, never a build machine, since it holds a token that writes the repo.
const GIT = join(WORK, "git");
const remote = (repo) => `${process.env.GIT_REMOTE ?? "https://github.com/"}${repo}.git`;
const header = (token) => `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

// A git command that reaches GitHub, with the token for that repo, if any, from the environment.
function gitEnv({ sourceToken, token, author }) {
  return {
    ...(sourceToken ? { SOURCE_AUTH: header(sourceToken) } : {}),
    ...(token ? { TARGET_AUTH: header(token) } : {}),
    ...(author ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email } : {}),
    GIT_TERMINAL_PROMPT: "0",
  };
}
const fromSource = (input) => (input.sourceToken ? `git -c "http.https://github.com/.extraheader=$SOURCE_AUTH"` : "git");
const toTarget = `git -c "http.https://github.com/.extraheader=$TARGET_AUTH"`;

async function freshGit() {
  await rm(GIT, { recursive: true, force: true });
  await mkdir(GIT, { recursive: true });
  await sh("git init -q -b main", GIT);
}

async function clone(input) {
  await freshGit();
  const env = gitEnv(input);
  await sh(`${fromSource(input)} fetch -q --no-tags ${remote(input.source)} ${input.commit}`, GIT, env);
  await sh(`${toTarget} push -q ${remote(input.target)} ${input.commit}:refs/heads/main`, GIT, env);
  note(`cloned ${input.source} at ${input.commit.slice(0, 7)} into ${input.target}`);
  return { commit: input.commit };
}

// Merges the source at a newer commit into the repo's branch. A repo cloned with the source's
// history merges as git does; one that started as a copy of its files, as Deploy to Cloudflare
// makes, takes the source's changes since the commit it started from.
async function merge(input) {
  await freshGit();
  const env = gitEnv(input);
  await sh(`${toTarget} fetch -q --no-tags ${remote(input.target)} refs/heads/${input.branch}`, GIT, env);
  await sh("git checkout -q -B work FETCH_HEAD", GIT, env);
  await sh(`${fromSource(input)} fetch -q --no-tags ${remote(input.source)} ${input.commit}`, GIT, env);
  const source = input.commit;
  if ((await capture(`git merge-base --is-ancestor ${source} HEAD`, GIT)).code === 0) {
    note("already up to date");
    return { commit: (await capture("git rev-parse HEAD", GIT)).stdout, upToDate: true };
  }
  const conflicts = async () => (await capture("git diff --name-only --diff-filter=U", GIT)).stdout.split("\n").filter(Boolean);
  let commit;
  if ((await capture(`git merge-base HEAD ${source}`, GIT)).code === 0) {
    if ((await capture(`git merge -q -m ${JSON.stringify(input.message)} ${source}`, GIT, env)).code !== 0) {
      const files = await conflicts();
      await capture("git merge --abort", GIT);
      return { conflicts: files };
    }
    commit = (await capture("git rev-parse HEAD", GIT)).stdout;
  } else {
    let base = input.base;
    if (!base) {
      const root = (await capture("git rev-list --max-parents=0 HEAD", GIT)).stdout.split("\n").at(-1);
      const started = (await capture(`git log -1 --format=%cI ${root}`, GIT)).stdout;
      base = (await capture(`git rev-list -1 --before=${JSON.stringify(started)} ${source}`, GIT)).stdout;
      if (!base) throw new Failed(`the repo shares no history with ${input.source}, and no source commit is older than its first commit, so there is nothing to merge from`);
      note(`the repo started from ${input.source} at ${base.slice(0, 7)}`);
    }
    if (!(await capture(`git diff --name-only ${base} ${source}`, GIT)).stdout) {
      note("the source has not changed since the repo started");
      return { commit: (await capture("git rev-parse HEAD", GIT)).stdout, upToDate: true };
    }
    if ((await capture(`git diff --binary ${base} ${source} | git apply --3way --index`, GIT, env)).code !== 0) {
      const files = await conflicts();
      return { conflicts: files.length ? files : ["(the changes did not apply)"] };
    }
    const tree = (await capture("git write-tree", GIT)).stdout;
    commit = (await capture(`git commit-tree ${tree} -p HEAD -p ${source} -m ${JSON.stringify(input.message)}`, GIT, env)).stdout;
  }
  await sh(`${toTarget} push -q ${remote(input.target)} ${commit}:refs/heads/${input.branch}`, GIT, env);
  note(`merged ${input.source} at ${source.slice(0, 7)} into ${input.target}`);
  return { commit, merged: source };
}

function need() {
  if (!app) throw new Failed("build first");
  return app;
}

const routes = {
  "/source": async (request) => {
    await rm(REPO, { recursive: true, force: true });
    await mkdir(REPO, { recursive: true });
    await receive(request);
    note("source unpacked");
    return {};
  },
  "/build": async (request) => build(await body(request)),
  "/migrate": async (request) => migrate(await body(request)),
  "/bundle": async () => bundle(),
  "/upload": async (request) => upload(await body(request)),
  "/git/clone": async (request) => clone(await body(request)),
  "/git/merge": async (request) => merge(await body(request)),
};

let busy = false;

createServer(async (request, response) => {
  const reply = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const url = new URL(request.url ?? "/", "http://builder");
  if (request.method === "GET" && url.pathname === "/") return reply(200, { ok: true });
  if (request.method === "GET" && url.pathname === "/log") return reply(200, { log: log.slice(-TAIL) });
  const route = routes[url.pathname];
  if (request.method !== "POST" || !route) return reply(404, { error: "not found" });
  if (busy) return reply(409, { error: "busy with another step" });
  busy = true;
  try {
    reply(200, await route(request));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    note(error instanceof Failed ? message : (error?.stack ?? message));
    reply(400, { error: message, log: log.slice(-TAIL) });
  } finally {
    busy = false;
  }
}).listen(Number(process.env.PORT ?? 8080), () => note("builder listening"));

process.on("uncaughtException", (error) => note(error.stack ?? String(error)));
await stat(REPO).catch(() => mkdir(REPO, { recursive: true }));

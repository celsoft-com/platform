import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withClient } from "./adapters/database.js";

// The test Postgres server: Postgres 18 or later, on a socket, one for every test process of an
// app, keeping its data between runs. testApp uses it, and so does this repo's own test setup.

// Postgres's programs: from the app's embedded-postgres, which npm installs for this machine, or
// else from the PATH, for a project that installs Postgres its own way.
function postgresBin(appDir: string): (program: string) => string {
  try {
    const wrapper = createRequire(join(appDir, "package.json")).resolve("embedded-postgres");
    const binaries = createRequire(wrapper).resolve(`@embedded-postgres/${process.platform}-${process.arch}`);
    return (program) => join(dirname(dirname(binaries)), "native", "bin", program);
  } catch {
    return (program) => program;
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// The app's server, shared by its test processes through a folder named after the app: each
// process registers its pid there, the first to take the lock starts the server and writes its
// address, and the rest wait for that. The folder doubles as the socket directory, so its path
// stays short enough for a Unix socket.
export async function sharedPostgres(appDir: string): Promise<string> {
  const home = join(tmpdir(), `platform-pg-${createHash("sha256").update(resolve(appDir)).digest("hex").slice(0, 12)}`);
  await mkdir(join(home, "pids"), { recursive: true });
  await writeFile(join(home, "pids", String(process.pid)), "");
  const lock = join(home, "lock");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const url = await readFile(join(home, "url"), "utf8").catch(() => undefined);
    if (url && (await answers(url))) return url;
    if (await mkdir(lock).then(() => true, () => false)) {
      try {
        // Checked again under the lock: another process may have just started one.
        const again = await readFile(join(home, "url"), "utf8").catch(() => undefined);
        if (again && (await answers(again))) return again;
        // A server the watcher was about to stop, kept now that this process has registered.
        const stopping = await readFile(join(home, "url.stopping"), "utf8").catch(() => undefined);
        if (stopping && (await answers(stopping))) {
          await rename(join(home, "url.stopping"), join(home, "url"));
          return stopping;
        }
        return await startPostgres(appDir, home);
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    }
    // A starter that died holding the lock leaves it behind; a minute is far longer than a start.
    const held = await stat(lock).catch(() => undefined);
    if (held && Date.now() - held.mtimeMs > 60_000) await rm(lock, { recursive: true, force: true });
    await sleep(100);
  }
  throw new Error(`testApp waited two minutes for another test process to start Postgres in ${home}; remove that folder and test again`);
}

async function answers(url: string): Promise<boolean> {
  return withClient(url, async () => true).catch(() => false);
}

async function startPostgres(appDir: string, home: string): Promise<string> {
  const bin = postgresBin(appDir);
  const version = tool(bin("postgres"), ["--version"], `testApp needs Postgres 18 or later: add embedded-postgres to the app's devDependencies, as \`new\` and \`upgrade\` do, or put Postgres 18 on the PATH`);
  const major = Number(/(\d+)\./.exec(version)?.[1]);
  if (!(major >= 18)) throw new Error(`testApp needs Postgres 18 or later, as Neon runs; found ${version.trim()}`);
  // Kept between runs, so its templates are too and a run starts with no initdb; one that will not
  // start, such as one an older Postgres made, is made again.
  const data = join(home, "data");
  const start = () => tool(bin("pg_ctl"), ["-D", data, "-l", join(home, "log"), "-w", "-o", `-k ${home} -c listen_addresses='' -c fsync=off -c max_connections=500`, "start"]);
  const make = async () => {
    await rm(data, { recursive: true, force: true });
    tool(bin("initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C", "--no-instructions"]);
    start();
  };
  if (await stat(join(data, "PG_VERSION")).then(() => true, () => false)) {
    try {
      start();
    } catch (error) {
      // Never remade under a server still running on it.
      const running = (() => {
        try {
          tool(bin("pg_ctl"), ["-D", data, "status"]);
          return true;
        } catch {
          return false;
        }
      })();
      if (running) throw error;
      await make();
    }
  } else await make();
  const url = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(home)}`;
  // Nobody uses it yet, so what an earlier run left, such as a test's database it never closed or a
  // template it was building when it ended, goes now; finished templates stay.
  await withClient(url, async (c) => {
    const { rows } = await c.query<{ datname: string }>("select datname from pg_database where datname like 'test\\_%' or datname like 'building\\_%'");
    for (const { datname } of rows) await c.query(`drop database if exists ${datname} with (force)`);
  });
  // Written whole, so a waiting process never reads half an address.
  await writeFile(join(home, "url.next"), url);
  await rename(join(home, "url.next"), join(home, "url"));
  // vitest can end a test process without running its exit handlers, so a process of its own
  // stops the server once no registered process is left, however they ended; its data stays.
  spawn(process.execPath, ["-e", STOP_WHEN_GONE, bin("pg_ctl"), data, home], { detached: true, stdio: "ignore" }).unref();
  return url;
}

const STOP_WHEN_GONE = `
const { execFileSync } = require("node:child_process");
const { mkdirSync, readdirSync, renameSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const [pgCtl, data, home] = process.argv.slice(1);
const pids = join(home, "pids");
const alive = () =>
  readdirSync(pids).filter((pid) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      rmSync(join(pids, pid), { force: true });
      return false;
    }
  }).length > 0;
const timer = setInterval(() => {
  if (alive()) return;
  // The address goes first, so a process starting now starts a new server instead; one that
  // registered in between keeps this one.
  try {
    renameSync(join(home, "url"), join(home, "url.stopping"));
  } catch {}
  if (alive()) {
    try {
      renameSync(join(home, "url.stopping"), join(home, "url"));
    } catch {}
    return;
  }
  // Stopped cleanly under the start lock, so the next run never finds it half stopped.
  try {
    mkdirSync(join(home, "lock"));
  } catch {
    return;
  }
  clearInterval(timer);
  try {
    execFileSync(pgCtl, ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
  } catch {}
  rmSync(join(home, "url.stopping"), { force: true });
  rmSync(join(home, "lock"), { recursive: true, force: true });
}, 500);
`;

function tool(command: string, args: string[], missing?: string): string {
  try {
    return execFileSync(command, args, { stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    const { code, stdout = "", stderr = "", message } = error as { code?: string; stdout?: string; stderr?: string; message: string };
    if (code === "ENOENT" && missing) throw new Error(missing);
    throw new Error(`${command} failed: ${message}\n${stdout}${stderr}`);
  }
}

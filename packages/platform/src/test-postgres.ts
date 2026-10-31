import { execFileSync, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "pg";

// The test Postgres server: Postgres 18 or later, on a socket, one for every test process of an
// app. testApp uses it, and so does this repo's own test setup.

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
  const client = new Client({ connectionString: url });
  return client.connect().then(
    () => client.end().then(() => true),
    () => false,
  );
}

async function startPostgres(appDir: string, home: string): Promise<string> {
  const bin = postgresBin(appDir);
  const version = tool(bin("postgres"), ["--version"], `testApp needs Postgres 18 or later: add embedded-postgres to the app's devDependencies, as \`new\` and \`upgrade\` do, or put Postgres 18 on the PATH`);
  const major = Number(/(\d+)\./.exec(version)?.[1]);
  if (!(major >= 18)) throw new Error(`testApp needs Postgres 18 or later, as Neon runs; found ${version.trim()}`);
  const data = join(home, `data-${randomUUID().slice(0, 8)}`);
  tool(bin("initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C", "--no-instructions"]);
  tool(bin("pg_ctl"), ["-D", data, "-l", join(home, "log"), "-w", "-o", `-k ${home} -c listen_addresses='' -c fsync=off -c max_connections=500`, "start"]);
  const url = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(home)}`;
  // Written whole, so a waiting process never reads half an address.
  await writeFile(join(home, "url.next"), url);
  await rename(join(home, "url.next"), join(home, "url"));
  // vitest can end a test process without running its exit handlers, so a process of its own
  // stops the server and removes its data once no registered process is left, however they ended.
  spawn(process.execPath, ["-e", STOP_WHEN_GONE, bin("pg_ctl"), data, home], { detached: true, stdio: "ignore" }).unref();
  return url;
}

const STOP_WHEN_GONE = `
const { execFileSync } = require("node:child_process");
const { readdirSync, renameSync, rmSync, writeFileSync } = require("node:fs");
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
  clearInterval(timer);
  try {
    execFileSync(pgCtl, ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
  } catch {}
  rmSync(data, { recursive: true, force: true });
  rmSync(join(home, "url.stopping"), { force: true });
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

#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CloudflareApi } from "./adapters/cloudflare.js";
import { NeonApi } from "./adapters/neon.js";
import { ShellMigrator, WranglerCli } from "./adapters/process.js";
import { ConfigError, loadConfig } from "./config.js";
import { cleanup, deploy, PreflightError, type Context } from "./lifecycle.js";
import { Run } from "./run.js";
import { loadSecrets } from "./secrets.js";

const usage = `usage: platform <command> [--dry-run] [--dir <app dir>]

commands:
  deploy           deploy prod
  preview <pr>     create or update the preview for a pull request
  cleanup <pr>     delete the preview for a pull request
  ci               run the command for the current GitHub Actions event`;

type Command = { name: "deploy" } | { name: "preview"; pr: number } | { name: "cleanup"; pr: number };

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, dir: { type: "string", default: "." }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || positionals.length === 0) {
    console.log(usage);
    return;
  }

  const command = positionals[0] === "ci" ? await commandForGitHubEvent() : parseCommand(positionals);
  if (!command) {
    console.log("nothing to do for this event");
    return;
  }

  const ctx = await context(resolve(values.dir), values["dry-run"]);
  if (command.name === "cleanup") {
    await cleanup(ctx, command.pr);
    return;
  }
  const { hostname } = await deploy(ctx, command.name === "deploy" ? { kind: "prod" } : { kind: "preview", pr: command.pr });
  if (!values["dry-run"]) console.log(`\nlive at https://${hostname}`);
}

function parseCommand([name, pr]: string[]): Command {
  if (name === "deploy") return { name };
  if (name === "preview" || name === "cleanup") return { name, pr: prNumber(pr) };
  throw new UsageError(`unknown command ${name}\n\n${usage}`);
}

async function commandForGitHubEvent(): Promise<Command | undefined> {
  const name = process.env.GITHUB_EVENT_NAME;
  const path = process.env.GITHUB_EVENT_PATH;
  if (!name || !path) throw new UsageError("`platform ci` runs only inside GitHub Actions");
  const event = JSON.parse(await readFile(path, "utf8")) as { action?: string; number?: number };
  if (name === "push") return { name: "deploy" };
  if (name === "pull_request") return event.action === "closed" ? { name: "cleanup", pr: event.number! } : { name: "preview", pr: event.number! };
  return undefined;
}

async function context(appDir: string, dryRun: boolean): Promise<Context> {
  const config = await loadConfig(appDir);
  const secrets = await loadSecrets(appDir);
  const cloudflareToken = requireToken(secrets, "CLOUDFLARE_API_TOKEN");
  const neonKey = config.database ? requireToken(secrets, "NEON_API_KEY") : "";
  return {
    config,
    secrets,
    run: new Run(dryRun, (line) => console.log(line)),
    ports: {
      cloudflare: new CloudflareApi(cloudflareToken),
      neon: new NeonApi(neonKey),
      wrangler: new WranglerCli(appDir, { CLOUDFLARE_API_TOKEN: cloudflareToken }),
      migrator: new ShellMigrator(appDir),
    },
  };
}

function requireToken(secrets: Record<string, string>, name: string): string {
  const value = secrets[name];
  if (!value) throw new PreflightError(`${name} is not set; add it to .env.secrets, or to the repo's GitHub secrets in CI`);
  return value;
}

function prNumber(value: string | undefined): number {
  const pr = Number(value);
  if (!Number.isInteger(pr) || pr <= 0) throw new UsageError(`expected a pull request number, got ${value ?? "nothing"}`);
  return pr;
}

class UsageError extends Error {}

main(process.argv.slice(2)).catch((error: unknown) => {
  const known = error instanceof ConfigError || error instanceof PreflightError || error instanceof UsageError;
  console.error(`✗ ${known ? (error as Error).message : error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});

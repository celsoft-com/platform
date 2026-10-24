#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { invalid, rules, scaffold, type Answers } from "./scaffold.js";

const usage = `usage: npm create @celsoft/platform-app <name> -- [--hostname <host>] [--neon-project <id>]`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { hostname: { type: "string" }, "neon-project": { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log(usage);
    return;
  }

  const answers: Partial<Answers> = { name: positionals[0], hostname: values.hostname, neonProject: values["neon-project"] };
  if (process.stdin.isTTY) await ask(answers);

  const bad = invalid(answers);
  if (bad.length > 0) {
    throw new Error(`${bad.map((key) => `${key}: ${rules[key].hint}`).join("\n")}\n\n${usage}`);
  }

  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const target = resolve(answers.name!);
  await scaffold(target, answers as Answers, version);

  console.log(`\nCreated ${answers.name}. Next:\n\n  cd ${answers.name}\n  npm install\n\nthen follow README.md for the first deploy.`);
}

async function ask(answers: Partial<Answers>): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const labels: Record<keyof Answers, string> = { name: "App name", hostname: "Prod hostname", neonProject: "Neon project id" };
  try {
    for (const key of Object.keys(labels) as (keyof Answers)[]) {
      while (!rules[key].pattern.test(answers[key] ?? "")) {
        if (answers[key]) console.log(`  must be ${rules[key].hint}`);
        answers[key] = (await rl.question(`${labels[key]}: `)).trim();
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

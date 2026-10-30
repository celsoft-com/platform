import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import type { Answers } from "../ports.js";

// Loaded into drizzle-kit's process with --import. drizzle-kit asks "created or renamed?" in a
// terminal prompt with no flag to answer it, so its prompt is pointed here: each question is
// answered from ANSWERS, or recorded unanswered for the platform to list.

export type Question = { kind: string; name: string; from: string[] };
export type Report = { questions: Question[]; used: string[] };

type Item = { name: string; schema?: string };
type Choice = Item | { from: Item; to: Item };
type Prompt = { tableName?: string; entityType?: string; state?: { items: Choice[] }; data?: { items: Choice[] } };

const PROMPT = 'return Promise.reject(new Error("Interactive prompts require a TTY terminal';
const answers: Answers = JSON.parse(process.env.PLATFORM_DRIZZLE_ANSWERS ?? '{"renames":{},"creates":[]}');
const report: Report = { questions: [], used: [] };

(globalThis as { platformAnswer?: unknown }).platformAnswer = (prompt: Prompt) => {
  const items = (prompt.state ?? prompt.data)!.items;
  const kind = prompt.tableName === undefined ? (prompt.entityType ?? "schema") : "column";
  const key = (item: Item) => (kind === "column" ? `${prompt.tableName}.${item.name}` : item.schema && item.schema !== "public" ? `${item.schema}.${item.name}` : item.name);
  const name = key(items[0] as Item);
  const from = items.slice(1).map((item) => key((item as { from: Item }).from));
  const submit = (index: number) => Promise.resolve({ status: "submitted", data: items[index] });
  if (answers.creates.includes(name)) {
    report.used.push(`--create ${name}`);
    return submit(0);
  }
  const renamed = from.indexOf(answers.renames[name] ?? "");
  if (renamed >= 0) {
    report.used.push(`--rename ${from[renamed]}=${name}`);
    return submit(renamed + 1);
  }
  report.questions.push({ kind, name, from });
  // Created, so drizzle-kit goes on and every later question is listed too.
  return submit(0);
};

registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (!url.endsWith("/drizzle-kit/bin.cjs")) return result;
    const source = String(result.source);
    if (!source.includes(PROMPT)) throw new Error("this drizzle-kit asks its rename questions in a way @celsoft/platform does not know; install the drizzle-kit version @celsoft/platform pins");
    return { ...result, source: source.replace(PROMPT, `return globalThis.platformAnswer(arguments[0]);${PROMPT}`) };
  },
});

// drizzle-kit prints an error it catches, such as a schema file that fails to load, and still
// exits 0 with no migration written, which reads as "up to date".
const printError = console.error;
console.error = (...args: unknown[]) => {
  process.exitCode = 1;
  printError(...args);
};

process.on("exit", () => writeFileSync(process.env.PLATFORM_DRIZZLE_REPORT!, JSON.stringify(report)));

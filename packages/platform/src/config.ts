import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";

export const CONFIG_FILE = "platform.jsonc";
export const CONFIG_VERSION = 1;

const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "must be a lowercase hostname such as app.example.com");

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(CONFIG_VERSION),
    // Leaves room for "-pr-<number>" within Cloudflare's 63-character Worker name limit.
    name: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/, "must start with a letter and use only a-z, 0-9 and -, at most 50 characters"),
    hostname,
    worker: z.string().min(1).describe("Path to the Worker's entry module, relative to platform.jsonc"),
    compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date such as 2026-10-01"),
    frontend: z.string().min(1).optional().describe("Directory holding the built static files"),
    database: z
      .object({
        neonProject: z.string().regex(/^[a-z]+-[a-z]+-\d+$/, "must be a Neon project id such as quiet-meadow-12345678, not a branch id"),
        migrate: z.string().min(1).describe("Command that runs migrations against $DATABASE_URL"),
      })
      .strict()
      .optional(),
    email: z.boolean().default(false).describe("Send email through Resend from noreply@ the app's own hostname; the app only sends"),
    auth: z.boolean().default(false).describe("Sign-up and login with email and password; needs database and email"),
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, "must be an UPPER_SNAKE_CASE name")).default([]),
  })
  .strict()
  .refine((c) => !c.auth || (c.database && c.email), { message: "auth needs both database and email", path: ["auth"] });

export type Config = z.output<typeof configSchema>;

export class ConfigError extends Error {}

const VARIABLE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export function configVariables(text: string): string[] {
  return [...new Set([...text.matchAll(VARIABLE)].map((m) => m[1]!))];
}

export function parseConfig(text: string, source = CONFIG_FILE, vars: Record<string, string> = {}): Config {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new ConfigError(`${source}: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }

  const missing = configVariables(text).filter((name) => !vars[name]);
  if (missing.length > 0) {
    throw new ConfigError(`${source} uses ${missing.join(", ")}; set them in .env, or as GitHub Actions variables in CI`);
  }
  const raw = substitute(parsed, vars);

  if (isObject(raw) && typeof raw.version === "number" && raw.version < CONFIG_VERSION) {
    throw new ConfigError(`${source}: version ${raw.version} is older than this platform's ${CONFIG_VERSION}; run \`platform upgrade\``);
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ConfigError(`${source} is invalid:\n${lines.join("\n")}`);
  }
  return result.data;
}

export async function readConfigText(dir: string): Promise<string> {
  const path = join(dir, CONFIG_FILE);
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new ConfigError(`${path} not found; run \`platform init\``);
  }
}

export async function loadConfig(dir: string, vars: Record<string, string> = {}): Promise<Config> {
  return parseConfig(await readConfigText(dir), join(dir, CONFIG_FILE), vars);
}

export function configJsonSchema(): object {
  return allowVariables(z.toJSONSchema(configSchema, { io: "input" }));
}

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return value.replace(VARIABLE, (_, name: string) => vars[name]!);
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

// Editors validate the file before substitution, so a patterned string may also be a ${NAME} reference.
function allowVariables(schema: unknown): object {
  if (Array.isArray(schema)) return schema.map(allowVariables);
  if (!isObject(schema)) return schema as object;
  const out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, allowVariables(v)]));
  if (typeof out.pattern === "string") {
    const { pattern, ...rest } = out;
    return { ...rest, anyOf: [{ pattern }, { pattern: "^\\$\\{[A-Z][A-Z0-9_]*\\}$" }] };
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

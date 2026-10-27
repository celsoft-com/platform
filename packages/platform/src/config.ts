import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";

export const CONFIG_FILE = "platform.jsonc";

const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "must be a lowercase hostname such as app.example.com");

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    // Never "--", which starts every suffix the platform adds; 50 leaves room for "--pr-<number>"
    // within Cloudflare's 63-character limit on Worker and bucket names.
    name: z
      .string()
      .regex(/^(?=.{3,50}$)[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "must be 3 to 50 characters of a-z, 0-9 and single hyphens, starting with a letter"),
    hostname,
    worker: z.string().min(1).describe("Path to the Worker's entry module, relative to platform.jsonc"),
    compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date such as 2026-10-01"),
    frontend: z.string().min(1).optional().describe("Directory holding the built static files"),
    database: z
      .object({
        neonProject: z.string().regex(/^[a-z]+-[a-z]+-\d+$/, "must be a Neon project id such as quiet-meadow-12345678, not a branch id"),
      })
      .describe("A Neon Postgres 18 database; the app's tables live in src/schema.ts")
      .strict()
      .optional(),
    email: z.boolean().default(false).describe("Send email through Resend from noreply@ the app's own hostname; the app only sends"),
    auth: z
      .union([
        z.boolean(),
        z
          .object({
            organizations: z.boolean().default(false).describe("Organizations with members, invitations, teams and a built-in Admins team"),
            apiTokens: z.boolean().default(false).describe("Personal API tokens people make at /tokens and send as Authorization: Bearer on /api/"),
          })
          .strict(),
      ])
      .default(false)
      .transform((auth) => (auth === true ? { organizations: false, apiTokens: false } : auth))
      .describe("Sign-up and login with email and password; needs database and email"),
    files: z.boolean().default(false).describe("Object storage in an R2 bucket, organized in folders"),
    live: z.boolean().default(false).describe("Live rooms: messages and presence over WebSockets, on Durable Objects"),
    mcp: z.boolean().default(false).describe("Serve endpoints marked for MCP at /mcp, to AI clients that sign in with OAuth; needs auth"),
    access: z.boolean().default(false).describe("Control points, grants and links through app.access; needs auth"),
    previews: z
      .object({
        sendEmailTo: z
          .array(z.string().regex(/^(\*|[a-z0-9._%+-]+)@[a-z0-9.-]+\.[a-z]{2,}$/, "must be a lowercase address such as sam@example.com, or *@example.com for a whole domain"))
          .default([])
          .describe("Addresses previews really email, such as your team's; every other address is only logged, since a preview's database is a copy of prod"),
      })
      .strict()
      .default({ sendEmailTo: [] }),
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, "must be an UPPER_SNAKE_CASE name")).default([]),
  })
  .strict()
  .refine((c) => !c.auth || (c.database && c.email), { message: "auth needs both database and email", path: ["auth"] })
  .refine((c) => !c.mcp || c.auth, { message: "mcp needs auth, since AI clients sign in as a user", path: ["mcp"] })
  .refine((c) => c.previews.sendEmailTo.length === 0 || c.email, { message: "previews.sendEmailTo needs email", path: ["previews"] })
  .refine((c) => !c.access || c.auth, { message: "access needs auth, since levels belong to users, teams and organizations", path: ["access"] });

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
    throw new ConfigError(`${source} uses ${missing.join(", ")}; set them in .env, then run \`npx @celsoft/platform init\` to copy them to GitHub`);
  }
  const raw = substitute(parsed, vars);

  const old = olderShape(raw);
  if (old.length > 0) {
    throw new ConfigError(`${source} has an older shape (${old.map((path) => path.join(".")).join(", ")}); run \`npx @celsoft/platform upgrade\` and commit the result`);
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ConfigError(`${source} is invalid:\n${lines.join("\n")}`);
  }
  return result.data;
}

// Fields earlier releases used, recognized by their presence so nobody has to write a version.
const RETIRED: string[][] = [["version"], ["database", "migrate"]];

function olderShape(raw: unknown): string[][] {
  return RETIRED.filter((path) => path.reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), raw) !== undefined);
}

// Rewrites an older file to the current shape, keeping its comments and layout.
export function upgradeConfigText(text: string): { text: string; changes: string[] } {
  const changes: string[] = [];
  for (const path of olderShape(parse(text, [], { allowTrailingComma: true }))) {
    text = applyEdits(text, modify(text, path, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    changes.push(`removed ${path.join(".")}`);
  }
  return { text, changes };
}

export async function readConfigText(dir: string): Promise<string> {
  const path = join(dir, CONFIG_FILE);
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new ConfigError(`${path} not found; run \`npx @celsoft/platform init\``);
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

// Apps: what the instance keeps for each one, and what it reads from an app's platform.jsonc.
// docs/design.md section 16, Apps, is the design.

import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { SetupError } from "./cloudflare.ts";
import type { Run } from "./deploy.ts";

export const CONFIG_FILE = "platform.jsonc";

// Everything named for an app is its name or starts with it and "--", which names never contain.
export const APP_NAME = /^(?=.{3,50}$)[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface App {
  name: string;
  repo: { owner: string; ownerId: number; name: string; id: number; private: boolean; defaultBranch: string };
  // The folder holding platform.jsonc, "" for the repo's root.
  dir: string;
  address: string;
  zone: { id: string; name: string };
  admins: string[];
  // Each command left out is found from the repo; an empty one is skipped.
  build: { install?: string; build?: string; test?: string };
  // The repo the app was cloned from, and its commit last merged into the app's repo; an app
  // added from a repo already in the instance's owner has none.
  source?: Upstream;
  // What the instance made for the app, found again by these on every deploy and on removal.
  resources: { neonProject?: string; region?: string };
  deployed?: { ref: string; commit: string; at: string };
  // The source's newer release, or newer default-branch commit if it makes no releases, not merged yet.
  available?: { ref: string; commit: string };
  // Addresses the app had before, whose domains and sending domains its next deploy removes.
  moved?: { address: string; zone: { id: string; name: string } }[];
  previews: number[];
  addedBy: string;
  addedAt: string;
}

export interface Upstream {
  owner: string;
  name: string;
  ref: string;
  commit: string;
}

// The part of platform.jsonc the instance acts on. The app's own framework checks the rest when it builds.
const features = z
  .object({
    worker: z.string().min(1),
    compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date such as 2026-10-01"),
    frontend: z.object({ dir: z.string().min(1), spa: z.boolean().default(false) }).optional(),
    database: z.boolean().default(false),
    email: z.boolean().default(false),
    auth: z.union([z.boolean(), z.object({}).passthrough()]).default(false).transform((a) => a !== false),
    files: z.boolean().default(false),
    live: z.boolean().default(false),
    mcp: z.boolean().default(false),
    access: z.boolean().default(false),
    rateLimit: z.number().int().default(1200),
    previews: z.object({ sendEmailTo: z.array(z.string()).default([]) }).default({ sendEmailTo: [] }),
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, "must be an UPPER_SNAKE_CASE name")).default([]),
  })
  .passthrough();

export type Features = z.output<typeof features>;

export interface AppConfig {
  features: Features;
  warnings: string[];
  // The file as the app's build reads it: the instance's name and address in place of the app's.
  text: string;
}

export function readConfig(text: string, name: string, address: string): AppConfig {
  const errors: ParseError[] = [];
  const raw = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
  if (errors.length) throw new SetupError(`${CONFIG_FILE} is not valid JSON: ${printParseErrorCode(errors[0]!.error)} at offset ${errors[0]!.offset}.`);
  if (!raw || typeof raw !== "object") throw new SetupError(`${CONFIG_FILE} must hold an object.`);
  const variables = [...new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]))];
  if (variables.length) throw new SetupError(`${CONFIG_FILE} uses ${variables.map((v) => `\${${v}}`).join(", ")}; an instance names and places every app itself, so remove them.`);
  const result = features.safeParse(raw);
  if (!result.success) throw new SetupError(`${CONFIG_FILE} is invalid: ${result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}.`);
  const f = result.data;
  const needs = [
    [f.auth && !(f.database && f.email), "auth needs database and email"],
    [f.mcp && !f.auth, "mcp needs auth"],
    [f.access && !f.auth, "access needs auth"],
  ] as const;
  const broken = needs.filter(([bad]) => bad).map(([, why]) => why);
  if (broken.length) throw new SetupError(`${CONFIG_FILE} is invalid: ${broken.join("; ")}.`);

  const warnings: string[] = [];
  for (const key of ["name", "hostname"] as const) {
    if (raw[key] !== undefined) warnings.push(`${CONFIG_FILE} sets ${key}, which this instance ignores: it names the app and gives it its address itself.`);
  }
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  let rewritten = applyEdits(text, modify(text, ["name"], name, options));
  rewritten = applyEdits(rewritten, modify(rewritten, ["hostname"], address, options));
  return { features: f, warnings, text: rewritten };
}

// What the app needs, in words, as Add app shows it.
export function needs(f: Features): string[] {
  return [
    "A Worker",
    ...(f.frontend ? ["Static files"] : []),
    ...(f.database ? ["A Postgres database"] : []),
    ...(f.email ? ["Email sending"] : []),
    ...(f.auth ? ["Sign-in"] : []),
    ...(f.files ? ["File storage"] : []),
    ...(f.live ? ["Live rooms"] : []),
    ...(f.mcp ? ["MCP for AI clients"] : []),
    ...(f.access ? ["Access control"] : []),
    ...f.secrets.map((s) => `Secret ${s}`),
  ];
}

// The Cloudflare names of everything an app or one of its previews uses.
export type Target = { kind: "prod" } | { kind: "preview"; pr: number };

export function names(app: string, target: Target) {
  if (target.kind === "prod") return { worker: app, hyperdrive: app, branch: undefined, bucket: `${app}--files`, filesPrefix: "" };
  const suffix = `pr-${target.pr}`;
  return { worker: `${app}--${suffix}`, hyperdrive: `${app}--${suffix}`, branch: suffix, bucket: `${app}--previews`, filesPrefix: `${suffix}/` };
}

export const previewAddress = (pr: number, address: string) => `pr-${pr}.${address}`;

// The zone an address belongs to: the longest of the account's domains it ends with.
export function zoneFor<Z extends { name: string }>(address: string, zones: Z[]): Z | undefined {
  return zones.filter((z) => address === z.name || address.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
}

// Where apps, their secrets and their runs are kept: the instance's storage, which only this Worker reaches.
export interface AppStore {
  list(): Promise<App[]>;
  get(name: string): Promise<App | undefined>;
  put(app: App): Promise<void>;
  patch(name: string, patch: Partial<App>): Promise<App | undefined>;
  delete(name: string): Promise<void>;
  // An app's own secrets: set by its admins, handed to its Workers, never sent back.
  secrets(name: string): Promise<Record<string, string>>;
  setSecret(name: string, key: string, value: string | undefined): Promise<void>;
  runs(name: string): Promise<Run[]>;
  // Queues a run; a queued run for the same app and target is replaced, since only the newest matters.
  enqueue(run: Run, host: string): Promise<void>;
  // Keeps an Add app between the form and GitHub's answer, taken once.
  hold(key: string, value: unknown): Promise<void>;
  take(key: string): Promise<unknown>;
}

export const appAdmins = async (apps: AppStore) => [...new Set((await apps.list()).flatMap((a) => a.admins))];

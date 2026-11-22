// The Worker's routes: a JSON API for the pages (/api/ for claiming, /admin/api/ behind Cloudflare
// Access), the GitHub App's webhook, and the built pages for every other path.

import { APP_PERMISSIONS, PERMISSIONS, SetupError } from "./cloudflare.ts";
import * as complete from "./complete.ts";
import { webhookSigned, type GitHubApp } from "./github.ts";
import { reserve, viewer, type InstanceRecord, type Viewer } from "./setup.ts";
import { SETUP_TOKEN_URL, WIDER_TOKEN_URL } from "./token-links.ts";

export interface Context extends complete.Context {
  // The built pages; absent in tests.
  assets?: { fetch: (request: Request) => Promise<Response> };
}

// What a step reports: what it confirmed, and the sentence that stopped it.
export interface StepResult {
  done: string[];
  error?: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

// Runs a step, turning its failure into the sentence the page shows: a setup error as written, anything else as a bug to report.
async function attempt(step: (done: string[]) => Promise<unknown>): Promise<Response> {
  const done: string[] = [];
  try {
    await step(done);
    return json({ done } satisfies StepResult);
  } catch (error) {
    if (error instanceof SetupError) return json({ done, error: error.message } satisfies StepResult, 400);
    console.error(error);
    return json({ done, error: `Something went wrong that setup did not expect: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` } satisfies StepResult, 400);
  }
}

async function body(request: Request): Promise<Record<string, unknown>> {
  return ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

// A saved secret is never sent back; its last four characters let the person recognize it.
const hint = (secret: string | undefined) => (secret ? `••••${secret.slice(-4)}` : "");

const build = (ctx: Context) => ({ version: ctx.self.version, deployedAt: ctx.self.deployedAt });

export async function handle(request: Request, ctx: Context): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const { store, self, fetcher } = ctx;
  const post = request.method === "POST";
  const record = await store.get();
  const stage = record?.state ?? "unclaimed";

  if (pathname === "/api/state") {
    return json({ build: build(ctx), stage, reserved: record?.state === "reserved" ? record.email : undefined, tokenUrl: SETUP_TOKEN_URL, permissions: Object.values(PERMISSIONS) });
  }
  if ((pathname === "/api/reserve" || pathname === "/api/reset") && post) {
    // Reserving belongs before the claim and resetting after it.
    if ((pathname === "/api/reset") !== (stage === "claimed")) {
      const error = stage === "claimed" ? "This instance is already claimed; sign in, or reset it at /reset." : "This instance is not claimed yet; reserve it at /.";
      return json({ done: [], error } satisfies StepResult, 409);
    }
    const input = await body(request);
    return attempt((done) => reserve(store, self, { token: text(input.token), email: text(input.email) }, done, fetcher));
  }

  if (pathname === "/github/webhook" && post) {
    if (!ctx.secrets.GITHUB_APP) return new Response("No GitHub App", { status: 404 });
    const event = await request.text();
    const signed = await webhookSigned(JSON.parse(ctx.secrets.GITHUB_APP) as GitHubApp, event, request.headers.get("x-hub-signature-256"));
    // Accepted and ignored until apps are deployed from their repos.
    return new Response(null, { status: signed ? 202 : 401 });
  }

  if (pathname.startsWith("/admin/api/")) {
    const who = await viewer(store, request.headers.get("cf-access-jwt-assertion"), fetcher);
    if (!who) return json({ error: "Not signed in to this instance." }, 401);
    return admin(request, pathname.slice("/admin/api/".length), who, ctx);
  }

  if (pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);
  return ctx.assets ? ctx.assets.fetch(request) : new Response("Not found", { status: 404 });
}

async function admin(request: Request, route: string, who: Viewer, ctx: Context): Promise<Response> {
  const record = (await ctx.store.get()) as InstanceRecord;

  if (route === "state") {
    const base = { build: build(ctx), viewer: who };
    if (who.role !== "super") return json(base);
    const setup = record.setup ?? {};
    const github = setup.github ? { slug: setup.github.slug, owner: setup.github.owner } : undefined;
    return json({
      ...base,
      setup: { token: !!setup.token, tokenWorks: await complete.tokenWorks(ctx), github },
      settings: {
        cloudflare: { token: hint(ctx.secrets.CLOUDFLARE_API_TOKEN) },
        github: { app: github?.slug ?? "", owner: github?.owner ?? "" },
        database: { neonKey: hint(ctx.secrets.NEON_API_KEY) },
        email: { resendKey: hint(ctx.secrets.RESEND_API_KEY) },
        admins: { emails: record.admins ?? [] },
      },
      tokenUrl: WIDER_TOKEN_URL,
      permissions: [...Object.values(PERMISSIONS), ...Object.values(APP_PERMISSIONS)],
    });
  }

  if (who.role !== "super") return json({ error: "Only the super admin can change this instance's setup." }, 403);
  if (request.method !== "POST") return json({ error: "Not found." }, 404);
  const input = await body(request);

  switch (route) {
    case "token":
      return attempt((done) => complete.widerToken(ctx, text(input.token), done));
    case "github/start":
      try {
        return json(await complete.githubStart(ctx, text(input.owner)));
      } catch (error) {
        if (error instanceof SetupError) return json({ done: [], error: error.message } satisfies StepResult, 400);
        throw error;
      }
    case "github/created":
      return attempt((done) => complete.githubCreated(ctx, text(input.code), text(input.state), done));
    case "github/installed":
      return attempt((done) => complete.githubInstalled(ctx, done));
    case "settings": {
      const changes = (input.changes ?? {}) as Record<string, unknown>;
      switch (input.category) {
        case "cloudflare":
          return attempt((done) => complete.widerToken(ctx, text(changes.token), done));
        case "database":
          return attempt((done) => complete.neon(ctx, text(changes.neonKey), done));
        case "email":
          return attempt((done) => complete.resend(ctx, text(changes.resendKey), done));
        case "admins":
          return attempt((done) => complete.admins(ctx, (Array.isArray(changes.emails) ? changes.emails : []).map(String).join("\n"), done));
      }
      return json({ done: [], error: "That setting cannot be changed here." } satisfies StepResult, 400);
    }
  }
  return json({ error: "Not found." }, 404);
}

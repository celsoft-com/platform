// Routing: initial setup at /, recovery at /reset, the admin pages under /admin behind Cloudflare
// Access, and the GitHub App's webhook.

import { adminsStep, databaseStep, domainsStep, emailStep, githubSend, githubStep, platformHome, superHome, tokenStep } from "./admin-pages.ts";
import { SetupError, type Zone } from "./cloudflare.ts";
import * as complete from "./complete.ts";
import { webhookSigned, type GitHubApp } from "./github.ts";
import { refusedPage, resetPage, setupPage, waitingPage, type Result } from "./pages.ts";
import { ADMIN_PATH, reserve, viewer, type InstanceRecord } from "./setup.ts";

export type Context = complete.Context;

const redirect = (to: string) => new Response(null, { status: 303, headers: { location: to } });

// Runs a step, turning its failure into the error the page shows: a setup error as written, anything else as a bug to report.
async function attempt(done: string[], step: () => Promise<unknown>): Promise<Result> {
  try {
    await step();
    return { email: "", done };
  } catch (error) {
    if (error instanceof SetupError) return { email: "", done, error: error.message };
    console.error(error);
    return { email: "", done, error: `Something went wrong that setup did not expect: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` };
  }
}

export async function handle(request: Request, ctx: Context): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const { store, self, fetcher } = ctx;
  const record = await store.get();

  if (pathname === "/" || pathname === "/reset") {
    const resetting = pathname === "/reset";
    // Setup belongs before the claim and reset after it.
    if (resetting !== (record?.state === "claimed")) return redirect(resetting ? "/" : ADMIN_PATH);
    const form = request.method === "POST" ? await request.formData() : undefined;
    const email = String(form?.get("email") ?? "");
    const done: string[] = [];
    const show = (result: Result) => (resetting ? resetPage(self, result) : record ? waitingPage(self, record.email, result) : setupPage(self, result));
    if (!form) return show({ email, done });
    const result = await attempt(done, () => reserve(store, self, { token: String(form.get("token") ?? ""), email }, done, fetcher));
    if (result.error) return show({ ...result, email });
    // Shown right away rather than redirected, so the steps it took stay on screen.
    return waitingPage(self, (await store.get())!.email, result);
  }

  if (pathname === "/github/webhook" && request.method === "POST") {
    if (!ctx.secrets.GITHUB_APP) return new Response("No GitHub App", { status: 404 });
    const body = await request.text();
    const signed = await webhookSigned(JSON.parse(ctx.secrets.GITHUB_APP) as GitHubApp, body, request.headers.get("x-hub-signature-256"));
    // Accepted and ignored until apps are deployed from their repos.
    return new Response(null, { status: signed ? 202 : 401 });
  }

  if (pathname !== ADMIN_PATH && !pathname.startsWith(`${ADMIN_PATH}/`)) return new Response("Not found", { status: 404 });

  const who = await viewer(store, request.headers.get("cf-access-jwt-assertion"), fetcher);
  // Access stops anyone else before the Worker, so this is a forged or stale request; sending a claimed instance to / would loop back here.
  if (!who) return record?.state === "claimed" ? refusedPage(self) : redirect("/");
  const latest = async () => (await store.get()) as InstanceRecord;
  if (pathname === ADMIN_PATH) return who.role === "super" ? superHome(self, who.email, await latest(), await complete.tokenWorks(ctx)) : platformHome(self, who.email);
  if (who.role !== "super") return refusedPage(self);

  const step = pathname.slice(ADMIN_PATH.length + 1);
  const form = request.method === "POST" ? await request.formData() : undefined;
  const done: string[] = [];
  const field = (name: string) => String(form?.get(name) ?? "");

  switch (step) {
    case "token":
      return form ? tokenStep(self, await attempt(done, () => complete.widerToken(ctx, field("token"), done))) : tokenStep(self, undefined, await complete.tokenWorks(ctx));
    case "domains": {
      const result = form ? await attempt(done, () => complete.domains(ctx, form.getAll("domain").map(String), done)) : undefined;
      let zones: Zone[] = [];
      const listed = await attempt([], async () => (zones = await complete.zones(ctx)));
      return domainsStep(self, zones, (await latest()).setup?.domains ?? [], result ?? (listed.error ? listed : undefined));
    }
    case "github": {
      if (!form) return githubStep(self, await latest());
      let sent: { action: string; manifest: string } | undefined;
      const result = await attempt(done, async () => (sent = await complete.githubStart(ctx, field("owner"))));
      return sent ? githubSend(self, sent.action, sent.manifest) : githubStep(self, await latest(), result);
    }
    case "github/created": {
      const result = await attempt(done, () => complete.githubCreated(ctx, url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "", done));
      return githubStep(self, await latest(), result);
    }
    case "github/installed": {
      const result = await attempt(done, () => complete.githubInstalled(ctx, done));
      return githubStep(self, await latest(), result);
    }
    case "database":
      return databaseStep(self, form ? await attempt(done, () => complete.neon(ctx, field("key"), done)) : undefined);
    case "email":
      return emailStep(self, form ? await attempt(done, () => complete.resend(ctx, field("key"), done)) : undefined);
    case "admins": {
      const result = form ? await attempt(done, () => complete.admins(ctx, field("emails"), done)) : undefined;
      return adminsStep(self, await latest(), result);
    }
  }
  return new Response("Not found", { status: 404 });
}

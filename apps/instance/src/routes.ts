// Routing: initial setup at /, recovery at /reset, and the super admin's home at /admin behind Cloudflare Access.

import { SetupError } from "./cloudflare.ts";
import { homePage, resetPage, setupPage, waitingPage } from "./pages.ts";
import { ADMIN_PATH, reserve, signedIn, type Self, type Store } from "./setup.ts";

const redirect = (to: string) => new Response(null, { status: 303, headers: { location: to } });

export async function handle(request: Request, state: Store, self: Self, fetcher: typeof fetch = fetch): Promise<Response> {
  const { pathname } = new URL(request.url);
  const record = await state.get();

  if (pathname === "/" || pathname === "/reset") {
    const resetting = pathname === "/reset";
    // Setup belongs before the claim and reset after it.
    if (resetting !== (record?.state === "claimed")) return redirect(resetting ? "/" : ADMIN_PATH);
    const form = request.method === "POST" ? await request.formData() : undefined;
    const email = String(form?.get("email") ?? "");
    const show = (error?: string) => (resetting ? resetPage(error, email) : record ? waitingPage(record.email, error, email) : setupPage(error, email));
    if (!form) return show();
    try {
      await reserve(state, self, { token: String(form.get("token") ?? ""), email }, fetcher);
    } catch (error) {
      if (error instanceof SetupError) return show(error.message);
      // Anything else is a bug; show it on the form, rather than Cloudflare's error page, so it can be reported.
      console.error(error);
      return show(`Something went wrong that setup did not expect: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
    return redirect("/");
  }

  if (pathname === ADMIN_PATH) {
    const email = await signedIn(state, request.headers.get("cf-access-jwt-assertion"), fetcher);
    if (email) return homePage(email);
    // Access stops anyone else before the Worker, so this is a forged or stale request; sending it to / would loop back here.
    return record?.state === "claimed" ? new Response("Not signed in as the super admin", { status: 403 }) : redirect("/");
  }

  return new Response("Not found", { status: 404 });
}

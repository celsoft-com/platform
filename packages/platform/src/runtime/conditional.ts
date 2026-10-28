// Conditional reads: a JSON read gets an ETag from its body, and a repeat read whose body has not
// changed answers 304 with no body. The Worker still does the read to know, so this saves the
// transfer, not the database work. Browsers keep the body privately and ask again every time, so
// no proxy or CDN ever holds it and a change is seen on the next read.
export async function conditional(request: Request, response: Response): Promise<Response> {
  if (request.method !== "GET") return response;
  if (response.status !== 200 || response.headers.has("etag") || response.headers.has("set-cookie")) return response;
  if (!/^application\/json\b/i.test(response.headers.get("content-type") ?? "")) return response;
  const cacheControl = response.headers.get("cache-control");
  if (cacheControl && /no-store/i.test(cacheControl)) return response;

  const body = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body)).slice(0, 16);
  const tag = `W/"${btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}"`;
  const headers = new Headers(response.headers);
  headers.set("etag", tag);
  if (!cacheControl) headers.set("cache-control", "private, no-cache");
  const asked = (request.headers.get("if-none-match") ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (asked.includes(tag.slice(2)) || asked.includes("*")) {
    for (const name of ["content-type", "content-length", "content-encoding"]) headers.delete(name);
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

import { z } from "zod";
import { EndpointError } from "./endpoint-error.js";

// The most one upload may be: a Worker's request body limit on Cloudflare's free and Pro plans.
export const MAX_UPLOAD = 100 * 1024 * 1024;
export const DEFAULT_UPLOAD = 10 * 1024 * 1024;
// AI clients send a file inside a JSON tool call, as base64, so they get smaller files.
export const MAX_MCP_UPLOAD = 5 * 1024 * 1024;

export interface UploadOptions {
  // Bytes; 10 MB by default, at most 100 MB.
  maxBytes?: number;
  // Media types such as "image/png" or "image/*"; any type by default.
  types?: readonly string[];
}

const uploads = new WeakMap<z.ZodType, Required<UploadOptions>>();

const allowed = (types: readonly string[], type: string) => types.length === 0 || types.some((t) => (t.endsWith("/*") ? type.startsWith(t.slice(0, -1)) : type === t));

// A file input field: the handler gets a `File`, checked against `maxBytes` and `types` before it
// runs. Over the API it arrives as multipart/form-data, which the generated client and testApp send
// for a File passed to `call`; over MCP as `{ name, type, base64 }`, up to 5 MB.
export function upload(options: UploadOptions = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_UPLOAD;
  const types = options.types ?? [];
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_UPLOAD) throw new Error(`upload's maxBytes is a whole number of bytes from 1 to ${MAX_UPLOAD} (100 MB); got ${maxBytes}`);
  const schema = z.file().superRefine((file, ctx) => {
    if (file.size > maxBytes) ctx.addIssue({ code: "custom", message: `the file is ${file.size} bytes; this takes at most ${maxBytes}` });
    if (!allowed(types, file.type)) ctx.addIssue({ code: "custom", message: `the file's type ${JSON.stringify(file.type)} is not one of ${types.join(", ")}` });
  });
  uploads.set(schema, { maxBytes, types });
  return schema;
}

// The input's upload fields and their limits; uploads are top-level fields of an object input.
export function uploadFields(input: z.ZodType): Record<string, Required<UploadOptions>> {
  const shape = (input as { shape?: Record<string, z.ZodType> }).shape ?? {};
  const unwrap = (s: z.ZodType): z.ZodType => (s instanceof z.ZodOptional || s instanceof z.ZodNullable ? unwrap(s.unwrap() as z.ZodType) : s);
  return Object.fromEntries(Object.entries(shape).flatMap(([name, s]) => (uploads.has(unwrap(s)) ? [[name, uploads.get(unwrap(s))!]] : [])));
}

// The most a request body to an endpoint may be: its files plus room for its other fields; any
// larger body is refused before it is read.
export const bodyLimit = (fields: Record<string, Required<UploadOptions>>) => Object.values(fields).reduce((sum, f) => sum + f.maxBytes, 0) + 1024 * 1024;

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

// The input schema an MCP client sees: each upload field is `{ name, type, base64 }`.
export function mcpInput(input: z.ZodType): z.ZodType {
  const fields = uploadFields(input);
  if (Object.keys(fields).length === 0) return input;
  const file = (max: number) => z.object({ name: z.string().min(1).max(255), type: z.string().max(255).default(""), base64: z.string().max(base64Length(max)) }).describe(`a file, as base64, up to ${max} bytes`);
  return (input as z.ZodObject).extend(Object.fromEntries(Object.entries(fields).map(([name, f]) => {
    const original = (input as z.ZodObject).shape[name] as z.ZodType;
    const sent = file(Math.min(f.maxBytes, MAX_MCP_UPLOAD));
    return [name, original instanceof z.ZodOptional ? sent.optional() : sent];
  })));
}

// Turns an MCP call's base64 files into the `File`s the handler gets, each checked as over the API.
export function filesFromMcp(input: z.ZodType, args: Record<string, unknown>): Record<string, unknown> {
  const fields = uploadFields(input);
  const out = { ...args };
  for (const [name, f] of Object.entries(fields)) {
    const sent = args[name] as { name: string; type: string; base64: string } | undefined;
    if (!sent) continue;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(sent.base64), (c) => c.charCodeAt(0));
    } catch {
      throw new EndpointError(400, `${name}: base64 is not valid`);
    }
    const file = new File([bytes as BlobPart], sent.name, { type: sent.type });
    if (file.size > Math.min(f.maxBytes, MAX_MCP_UPLOAD)) throw new EndpointError(413, `${name}: the file is ${file.size} bytes; over MCP this takes at most ${Math.min(f.maxBytes, MAX_MCP_UPLOAD)}`);
    if (!allowed(f.types, file.type)) throw new EndpointError(400, `${name}: the file's type ${JSON.stringify(file.type)} is not one of ${f.types.join(", ")}`);
    out[name] = file;
  }
  return out;
}

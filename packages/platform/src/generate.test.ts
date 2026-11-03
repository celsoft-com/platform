import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate } from "./generate.js";

// An app whose Worker imports a module that only its own `generate` script writes.
async function app(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "generate-"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "platform.jsonc"), JSON.stringify({ name: "probe", hostname: "probe.example", worker: "src/worker.ts", compatibilityDate: "2026-10-01" }));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "probe", private: true, scripts }));
  await writeFile(join(dir, "make.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("src/content.ts", 'export const claims = ["/docs"];');`);
  await writeFile(join(dir, "src/worker.ts"), `import { claims } from "./content"; export default { endpoints: {}, pages: claims, staticPoints: {} };`);
  return dir;
}

describe("generate", () => {
  it("runs the app's own generate script first, so the Worker can import what it writes", async () => {
    const dir = await app({ generate: "node make.mjs" });
    const { pages } = await generate(dir);
    expect(pages).toEqual(["/docs"]);
    expect(await readFile(join(dir, ".platform/client.ts"), "utf8")).toContain("createCall");
  }, 60_000);

  it("refuses a generate script that would run platform generate again", async () => {
    const dir = await app({ generate: "node make.mjs && platform generate" });
    await expect(generate(dir)).rejects.toThrow(/runs `platform generate`/);
  });
});

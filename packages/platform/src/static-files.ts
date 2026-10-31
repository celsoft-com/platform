import { readdir } from "node:fs/promises";
import { relative, sep } from "node:path";

// Every file under the frontend folder, relative to it with / between folders; none when it is
// missing, as before a first build.
export async function listStaticFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, `${e.parentPath}${sep}${e.name}`).split(sep).join("/"))
    .sort();
}

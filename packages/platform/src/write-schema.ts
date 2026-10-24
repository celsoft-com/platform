import { writeFile } from "node:fs/promises";
import { configJsonSchema } from "./config.js";

await writeFile(new URL("../schema.json", import.meta.url), JSON.stringify(configJsonSchema(), null, 2) + "\n");

import { platform } from "@celsoft/platform/vite";
import { defineConfig } from "vite";

// The page builds into dist/, which platform.jsonc deploys; `platform dev` runs Vite with the
// Worker's paths forwarded to the local Worker.
export default defineConfig({ plugins: [platform()] });

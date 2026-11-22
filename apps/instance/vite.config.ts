import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The instance's pages, built into dist/ for the Worker to serve as static assets.
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [svelte()],
  build: { outDir: "dist", emptyOutDir: true },
});

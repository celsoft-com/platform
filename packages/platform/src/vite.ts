import { SCREEN_PATHS } from "./runtime/screens.js";

declare const process: { env: Record<string, string | undefined> };

// What the local Worker answers; everything else is the frontend's dev server.
const WORKER_PATHS = ["/api", "/mcp", "/.well-known", ...SCREEN_PATHS];

// A Vite plugin for `platform dev`: Vite serves the frontend with instant reloads and forwards
// the Worker's paths to the local Worker, on the port the platform chose.
export function platform(): { name: string; config(): object } {
  return {
    name: "celsoft-platform",
    config() {
      const target = process.env.PLATFORM_WORKER_URL ?? "http://localhost:8787";
      const port = Number(process.env.PLATFORM_DEV_PORT ?? 5173);
      return {
        server: {
          port,
          strictPort: true,
          proxy: Object.fromEntries(WORKER_PATHS.map((path) => [path, { target, ws: path === "/api" }])),
        },
      };
    },
  };
}

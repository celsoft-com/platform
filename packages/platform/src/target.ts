import type { Config } from "./config.js";

export type Target = { kind: "prod" } | { kind: "preview"; pr: number };

export interface Names {
  worker: string;
  hyperdrive: string;
  neonBranch: string | undefined;
  bucket: string;
  filesPrefix: string;
}

// Prod gets its own bucket; previews share one, each under its PR's folder.
export function names(config: Config, target: Target): Names {
  if (target.kind === "prod") {
    return { worker: config.name, hyperdrive: config.name, neonBranch: undefined, bucket: `${config.name}-files`, filesPrefix: "" };
  }
  const suffix = `pr-${target.pr}`;
  return {
    worker: `${config.name}-${suffix}`,
    hyperdrive: `${config.name}-${suffix}`,
    neonBranch: suffix,
    bucket: `${config.name}-previews`,
    filesPrefix: `${suffix}/`,
  };
}

export function previewHostname(worker: string, zoneName: string): string {
  return `${worker}.${zoneName}`;
}

export function originOf(connectionUri: string): string {
  const url = new URL(connectionUri);
  return `${url.username}@${url.host}${url.pathname}`;
}

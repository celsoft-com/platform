import type { Config } from "./config.js";

export type Target = { kind: "prod" } | { kind: "preview"; pr: number };

export interface Names {
  worker: string;
  hyperdrive: string;
  neonBranch: string | undefined;
  bucket: string;
  filesPrefix: string;
}

// Every name is the app name, alone or followed by a suffix after `--`, which app names never
// contain. Prod gets its own bucket; previews share one, each under its PR's folder.
export function names(config: Config, target: Target): Names {
  if (target.kind === "prod") {
    return { worker: config.name, hyperdrive: config.name, neonBranch: undefined, bucket: `${config.name}--files`, filesPrefix: "" };
  }
  const suffix = `pr-${target.pr}`;
  return {
    worker: `${config.name}--${suffix}`,
    hyperdrive: `${config.name}--${suffix}`,
    neonBranch: suffix,
    bucket: `${config.name}--previews`,
    filesPrefix: `${suffix}/`,
  };
}

export const previewPattern = (app: string) => new RegExp(`^${app}--pr-(\\d+)$`);

export function previewHostname(pr: number, hostname: string): string {
  return `pr-${pr}.${hostname}`;
}

export function originOf(connectionUri: string): string {
  const url = new URL(connectionUri);
  return `${url.username}@${url.host}${url.pathname}`;
}

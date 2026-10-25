import type { Config } from "./config.js";
import type { Hyperdrive, Ports } from "./ports.js";

// Cloudflare has no project scope inside an account, so a matching name never proves the
// platform made a resource. Each resource carries proof instead, checked before any change.
export const PLATFORM_TAG = "celsoft-platform";
export const appTag = (app: string) => `app:${app}`;
export const BUCKET_MARKER = ".celsoft-platform";

export class UnprovenError extends Error {
  constructor(kind: string, name: string, app: string) {
    super(`${kind} ${name} exists, but nothing shows the platform made it for ${app}, so it was left untouched; remove it by hand if it is yours to remove, or choose another app name`);
  }
}

export interface OwnedWorker {
  name: string;
  hyperdriveIds: string[];
}

// Undefined when there is no such Worker; throws when it exists without this app's tags.
export async function ownedWorker(ports: Ports, config: Config, name: string): Promise<OwnedWorker | undefined> {
  const owner = await ports.cloudflare.workerOwner(name);
  if (!owner) return undefined;
  if (owner.app !== config.name) throw new UnprovenError("Worker", name, config.name);
  return { name, hyperdriveIds: owner.hyperdriveIds };
}

// A Hyperdrive config is the app's when one of its Workers binds it, or when it points at a
// database in the app's own Neon project, which covers a config whose Worker never deployed.
export async function requireOwnedHyperdrive(ports: Ports, config: Config, hyperdrive: Hyperdrive, boundIds: string[]): Promise<void> {
  if (boundIds.includes(hyperdrive.id)) return;
  const host = hyperdrive.origin.split("@")[1]?.split("/")[0];
  if (config.database && host && (await ports.neon.endpointHosts(config.database.neonProject)).includes(host)) return;
  throw new UnprovenError("Hyperdrive config", hyperdrive.name, config.name);
}

// True when the bucket exists and its marker names this app; throws when it names nothing or another app.
export async function ownedBucket(ports: Ports, config: Config, name: string): Promise<boolean> {
  const owner = await ports.cloudflare.bucketOwner(name);
  if (owner === undefined) return false;
  if (owner !== config.name) throw new UnprovenError("R2 bucket", name, config.name);
  return true;
}

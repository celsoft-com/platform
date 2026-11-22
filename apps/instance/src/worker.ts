// The Platform Instance's Worker: its state, its built pages, and the request handler routes.ts defines.

import { DurableObject } from "cloudflare:workers";
import { handle } from "./routes.ts";
import type { Secrets } from "./complete.ts";
import type { InstanceRecord, Store } from "./setup.ts";

export interface Env extends Secrets {
  STATE: DurableObjectNamespace<InstanceState>;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  ASSETS: Fetcher;
}

// The one record of the instance's state, kept where only this Worker reaches it.
export class InstanceState extends DurableObject {
  async read(): Promise<InstanceRecord | undefined> {
    return this.ctx.storage.get<InstanceRecord>("record");
  }

  async write(record: InstanceRecord): Promise<void> {
    await this.ctx.storage.put("record", record);
  }
}

function store(env: Env): Store {
  const stub = env.STATE.get(env.STATE.idFromName("instance"));
  return { get: () => stub.read(), put: (record) => stub.write(record) };
}

export default {
  fetch(request, env) {
    const self = { version: env.CF_VERSION_METADATA.id, deployedAt: env.CF_VERSION_METADATA.timestamp, host: new URL(request.url).host };
    const { CLOUDFLARE_API_TOKEN, GITHUB_APP, NEON_API_KEY, RESEND_API_KEY } = env;
    return handle(request, { store: store(env), self, secrets: { CLOUDFLARE_API_TOKEN, GITHUB_APP, NEON_API_KEY, RESEND_API_KEY }, fetcher: fetch, assets: env.ASSETS });
  },
} satisfies ExportedHandler<Env>;

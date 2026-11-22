// The Platform Instance's Worker: its state, and the request handler routes.ts defines.

import { DurableObject } from "cloudflare:workers";
import { handle } from "./routes.ts";
import type { InstanceRecord, Store } from "./setup.ts";

export interface Env {
  STATE: DurableObjectNamespace<InstanceState>;
  CF_VERSION_METADATA: WorkerVersionMetadata;
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
    return handle(request, store(env), { version: env.CF_VERSION_METADATA.id, host: new URL(request.url).host });
  },
} satisfies ExportedHandler<Env>;

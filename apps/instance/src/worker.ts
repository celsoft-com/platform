// The Platform Instance's Worker: its state, its apps' runs, the machine apps are built in, its
// built pages, and the request handler routes.ts defines.

import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { checkUpdates, deployEnv, type AppContext } from "./app-routes.ts";
import type { App, AppStore } from "./apps.ts";
import type { Secrets } from "./complete.ts";
import { cleanup, deploy, type Run } from "./deploy.ts";
import { handle } from "./routes.ts";
import type { InstanceRecord, Store } from "./setup.ts";

export interface Env extends Secrets {
  STATE: DurableObjectNamespace<InstanceState>;
  RUNS: DurableObjectNamespace<AppRuns>;
  BUILDER: DurableObjectNamespace<Builder>;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  ASSETS: Fetcher;
}

// The instance's record and its apps, kept where only this Worker reaches them.
export class InstanceState extends DurableObject {
  async read(): Promise<InstanceRecord | undefined> {
    return this.ctx.storage.get<InstanceRecord>("record");
  }

  async write(record: InstanceRecord): Promise<void> {
    await this.ctx.storage.put("record", record);
  }

  async apps(): Promise<App[]> {
    return [...(await this.ctx.storage.list<App>({ prefix: "app:" })).values()];
  }

  async app(name: string): Promise<App | undefined> {
    return this.ctx.storage.get<App>(`app:${name}`);
  }

  async putApp(app: App): Promise<void> {
    await this.ctx.storage.put(`app:${app.name}`, app);
  }

  // One call, so a deploy finishing and an admin's change never overwrite each other.
  async patchApp(name: string, patch: Partial<App>): Promise<App | undefined> {
    const app = await this.app(name);
    if (!app) return undefined;
    const next = { ...app, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (next as Record<string, unknown>)[key];
    await this.putApp(next);
    return next;
  }

  async deleteApp(name: string): Promise<void> {
    await this.ctx.storage.delete([`app:${name}`, `secrets:${name}`]);
  }

  async appSecrets(name: string): Promise<Record<string, string>> {
    return (await this.ctx.storage.get<Record<string, string>>(`secrets:${name}`)) ?? {};
  }

  // Held for at most an hour; GitHub's codes last ten minutes.
  async hold(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(`held:${key}`, { value, at: Date.now() });
  }

  async take(key: string): Promise<unknown> {
    const held = await this.ctx.storage.get<{ value: unknown; at: number }>(`held:${key}`);
    await this.ctx.storage.delete(`held:${key}`);
    return held && Date.now() - held.at < 3_600_000 ? held.value : undefined;
  }

  async setAppSecret(name: string, key: string, value: string | undefined): Promise<void> {
    const secrets = await this.appSecrets(name);
    if (value === undefined) delete secrets[key];
    else secrets[key] = value;
    await this.ctx.storage.put(`secrets:${name}`, secrets);
  }
}

export const RUNS_KEPT = 30;

// One app's runs, run one at a time from an alarm, which may take the minutes a build needs.
export class AppRuns extends DurableObject<Env> {
  async list(): Promise<Run[]> {
    return (await this.ctx.storage.get<Run[]>("runs")) ?? [];
  }

  private async save(runs: Run[]): Promise<void> {
    await this.ctx.storage.put("runs", runs.slice(-RUNS_KEPT));
  }

  async enqueue(run: Run, host: string): Promise<void> {
    const same = (r: Run) => r.state === "queued" && r.kind === run.kind && JSON.stringify(r.target) === JSON.stringify(run.target);
    await this.save([...(await this.list()).filter((r) => !same(r)), run]);
    await this.ctx.storage.put("host", host);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    let runs = await this.list();
    // A run still marked running was cut off, such as by a new version of the instance.
    for (const r of runs) if (r.state === "running") Object.assign(r, { state: "failed", error: "The run was interrupted; deploy again.", finishedAt: new Date().toISOString() });
    const run = runs.find((r) => r.state === "queued");
    if (!run) return this.save(runs);
    Object.assign(run, { state: "running", startedAt: new Date().toISOString() });
    await this.save(runs);
    const write = async (changed: Run) => {
      runs = (await this.list()).map((r) => (r.id === changed.id ? changed : r));
      await this.save(runs);
    };

    const state = stateStub(this.env);
    try {
      const record = await state.read();
      const app = await state.app(run.app);
      if (!record || !app) throw new Error(`${run.app} is no longer an app here.`);
      const host = (await this.ctx.storage.get<string>("host")) ?? "";
      const env = deployEnv(context(this.env, host), record, host, await state.appSecrets(app.name));
      const outcome = run.kind === "deploy" ? await deploy(env, app, run, write) : await cleanup(env, app, run, write);
      await state.patchApp(app.name, outcome.patch);
      Object.assign(run, { state: "done" });
    } catch (error) {
      if (!(error instanceof Error && error.constructor.name === "SetupError")) console.error(error);
      Object.assign(run, { state: "failed", error: error instanceof Error ? error.message : String(error) });
    }
    run.finishedAt = new Date().toISOString();
    await write(run);
    if ((await this.list()).some((r) => r.state === "queued")) await this.ctx.storage.setAlarm(Date.now());
  }
}

// The throwaway machine an app is built in; builder/ holds its image.
export class Builder extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "20m";
}

function stateStub(env: Env) {
  return env.STATE.get(env.STATE.idFromName("instance"));
}

function store(env: Env): Store {
  const stub = stateStub(env);
  return { get: () => stub.read(), put: (record) => stub.write(record) };
}

function apps(env: Env): AppStore {
  const stub = stateStub(env);
  const runs = (name: string) => env.RUNS.get(env.RUNS.idFromName(name));
  return {
    list: () => stub.apps(),
    get: (name) => stub.app(name),
    put: (app) => stub.putApp(app),
    patch: (name, patch) => stub.patchApp(name, patch),
    delete: (name) => stub.deleteApp(name),
    secrets: (name) => stub.appSecrets(name),
    setSecret: (name, key, value) => stub.setAppSecret(name, key, value),
    runs: (name) => runs(name).list(),
    enqueue: (run, host) => runs(run.app).enqueue(run, host),
    hold: (key, value) => stub.hold(key, value),
    take: (key) => stub.take(key),
  };
}

function context(env: Env, host: string): AppContext {
  const { CLOUDFLARE_API_TOKEN, GITHUB_APP, NEON_API_KEY, RESEND_API_KEY } = env;
  return {
    store: store(env),
    apps: apps(env),
    self: { version: env.CF_VERSION_METADATA.id, deployedAt: env.CF_VERSION_METADATA.timestamp, host },
    secrets: { CLOUDFLARE_API_TOKEN, GITHUB_APP, NEON_API_KEY, RESEND_API_KEY },
    fetcher: fetch,
    builder: (run) => {
      const machine = getContainer(env.BUILDER, run);
      return { fetch: (request) => machine.fetch(request), destroy: () => machine.destroy() };
    },
  };
}

export default {
  fetch(request, env) {
    return handle(request, { ...context(env, new URL(request.url).host), assets: env.ASSETS });
  },
  async scheduled(_event, env, ctx) {
    const record = await store(env).get();
    if (record?.state !== "claimed" || !record.host) return;
    ctx.waitUntil(checkUpdates(context(env, record.host)));
  },
} satisfies ExportedHandler<Env>;

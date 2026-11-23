// Apps kept in memory, for tests.

import type { App, AppStore } from "./apps.ts";
import type { Run } from "./deploy.ts";

export class MemoryApps implements AppStore {
  apps = new Map<string, App>();
  secretValues = new Map<string, Record<string, string>>();
  queued: Run[] = [];
  history = new Map<string, Run[]>();

  async list() {
    return [...this.apps.values()];
  }
  async get(name: string) {
    return this.apps.get(name);
  }
  async put(app: App) {
    this.apps.set(app.name, structuredClone(app));
  }
  async patch(name: string, patch: Partial<App>) {
    const app = this.apps.get(name);
    if (!app) return undefined;
    const next = { ...app, ...patch };
    this.apps.set(name, next);
    return next;
  }
  async delete(name: string) {
    this.apps.delete(name);
    this.secretValues.delete(name);
  }
  async secrets(name: string) {
    return { ...this.secretValues.get(name) };
  }
  async setSecret(name: string, key: string, value: string | undefined) {
    const all = { ...this.secretValues.get(name) };
    if (value === undefined) delete all[key];
    else all[key] = value;
    this.secretValues.set(name, all);
  }
  async runs(name: string) {
    return [...(this.history.get(name) ?? []), ...this.queued.filter((r) => r.app === name)];
  }
  async enqueue(run: Run) {
    this.queued = [...this.queued.filter((r) => !(r.app === run.app && r.kind === run.kind && JSON.stringify(r.target) === JSON.stringify(run.target))), run];
  }
}

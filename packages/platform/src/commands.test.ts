import { beforeEach, describe, expect, it } from "vitest";
import { confirmDestroy, ownerReset, UsageError } from "./commands.js";
import { parseConfig, type Config } from "./config.js";
import { fakePorts } from "./fakes.js";
import { deploy, type Context } from "./lifecycle.js";
import { Run } from "./run.js";
import { fakeTerminal } from "./terminal.js";

const config: Config = parseConfig(`{
  "name": "demo",
  "hostname": "demo.example.com",
  "worker": "src/worker.ts",
  "compatibilityDate": "2026-10-01",
  "database": true,
  "email": true,
  "auth": true
}`);

let ports: ReturnType<typeof fakePorts>;
const ctx = (): Context => ({
  config,
  ports,
  run: new Run(false, () => {}),
  secrets: { NEON_PROJECT_ID: "quiet-meadow-12345678" },
  repo: async () => ({ id: 101, name: "acme/demo" }),
  now: () => new Date("2026-10-24T12:34:56Z"),
});

beforeEach(() => {
  ports = fakePorts();
});

describe("commands through a terminal", () => {
  it("C1: destroy needs someone at a terminal, the app's name typed, and a last yes", async () => {
    await deploy(ctx(), { kind: "prod" });
    await expect(confirmDestroy(ctx(), "demo", false, fakeTerminal([], { interactive: false }))).rejects.toThrow(UsageError);

    const wrongName = fakeTerminal(["dmeo"]);
    await confirmDestroy(ctx(), "demo", false, wrongName);
    expect(wrongName.lines.at(-1)).toBe("Name did not match; nothing was deleted.");
    const no = fakeTerminal(["demo", "n"]);
    await confirmDestroy(ctx(), "demo", false, no);
    expect(no.lines.at(-1)).toBe("Nothing was deleted.");
    expect(ports.cloudflare.workers.size).toBe(1);

    const yes = fakeTerminal(["demo", "yes"]);
    await confirmDestroy(ctx(), "demo", false, yes);
    expect(ports.cloudflare.workers.size).toBe(0);
  });

  it("C2: owner reset asks for the password twice at a terminal, and refuses a mismatch or a short one", async () => {
    await expect(ownerReset(ctx(), config, "a@example.com", undefined, fakeTerminal(["first-password", "other-password"]))).rejects.toThrow(/did not match/);
    await expect(ownerReset(ctx(), config, "a@example.com", undefined, fakeTerminal(["short", "short"]))).rejects.toThrow(/at least 8/);
    const dry = fakeTerminal(["a-long-password", "a-long-password"]);
    await ownerReset({ ...ctx(), run: new Run(true, () => {}) }, config, "a@example.com", undefined, dry);
    expect(dry.lines.at(-1)).toBe("~ would make a@example.com the owner on production and set its password");
  });
});

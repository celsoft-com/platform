import { describe, expect, it } from "vitest";
import { ConfigError, configJsonSchema, configVariables, parseConfig } from "./config.js";

const valid = `{
  // comments and trailing commas are allowed
  "version": 1,
  "name": "demo",
  "hostname": "demo.example.com",
  "worker": "src/worker.ts",
  "compatibilityDate": "2026-10-01",
  "database": { "neonProject": "quiet-meadow-12345678" },
}`;

describe("parseConfig", () => {
  it("accepts a valid file and defaults secrets", () => {
    const config = parseConfig(valid);
    expect(config.name).toBe("demo");
    expect(config.database?.neonProject).toBe("quiet-meadow-12345678");
    expect(config.secrets).toEqual([]);
  });

  it("rejects a Neon branch id with a hint", () => {
    expect(() => parseConfig(valid.replace("quiet-meadow-12345678", "br-quiet-meadow-abcdefgh"))).toThrow(/not a branch id/);
  });

  it("rejects unknown keys", () => {
    expect(() => parseConfig(valid.replace(`"version": 1,`, `"version": 1, "extra": true,`))).toThrow(/extra/);
  });

  it("tells an older config to upgrade", () => {
    expect(() => parseConfig(`{ "version": 0 }`)).toThrow(/platform upgrade/);
  });

  it("reports JSON syntax errors", () => {
    expect(() => parseConfig(`{ "version": `)).toThrow(ConfigError);
  });

  it("lists every invalid field", () => {
    const error = (() => {
      try {
        parseConfig(`{ "version": 1, "name": "Demo", "hostname": "x" }`);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toMatch(/name:/);
    expect(error?.message).toMatch(/hostname:/);
    expect(error?.message).toMatch(/worker:/);
  });
});

describe("variables", () => {
  const withVars = valid.replace(`"demo.example.com"`, `"\${APP_HOSTNAME}"`).replace(`"quiet-meadow-12345678"`, `"\${APP_NEON}"`);

  it("lists the variables a config uses", () => {
    expect(configVariables(withVars)).toEqual(["APP_HOSTNAME", "APP_NEON"]);
  });

  it("fills them in before validating", () => {
    const config = parseConfig(withVars, "platform.jsonc", { APP_HOSTNAME: "app.example.com", APP_NEON: "quiet-meadow-12345678" });
    expect(config.hostname).toBe("app.example.com");
    expect(config.database?.neonProject).toBe("quiet-meadow-12345678");
  });

  it("names every missing variable", () => {
    expect(() => parseConfig(withVars, "platform.jsonc", { APP_HOSTNAME: "app.example.com" })).toThrow(/uses APP_NEON;/);
  });

  it("validates the filled-in value", () => {
    expect(() => parseConfig(withVars, "platform.jsonc", { APP_HOSTNAME: "Bad", APP_NEON: "quiet-meadow-12345678" })).toThrow(/hostname:/);
  });
});

describe("configJsonSchema", () => {
  it("produces a schema editors can use", () => {
    expect(configJsonSchema()).toMatchObject({ type: "object", required: expect.arrayContaining(["name", "hostname"]) });
  });
});

import { describe, expect, it } from "vitest";
import { ConfigError, configJsonSchema, configVariables, parseConfig, upgradeConfigText } from "./config.js";

const valid = `{
  // comments and trailing commas are allowed
  "name": "demo",
  "hostname": "demo.example.com",
  "worker": "src/worker.ts",
  "compatibilityDate": "2026-10-01",
  "database": true,
}`;

describe("parseConfig", () => {
  it("accepts a valid file and defaults secrets", () => {
    const config = parseConfig(valid);
    expect(config.name).toBe("demo");
    expect(config.database).toBe(true);
    expect(config.secrets).toEqual([]);
  });

  it("turns access on only with auth", () => {
    const withAccess = (fields: string) => parseConfig(valid.replace(`"name": "demo",`, `"name": "demo", ${fields}`)).access;
    expect(parseConfig(valid).access).toBe(false);
    expect(withAccess(`"email": true, "auth": true, "access": true,`)).toBe(true);
    expect(() => withAccess(`"access": true,`)).toThrow(/access needs auth/);
  });

  it("lists the addresses previews may email, only with email on", () => {
    const withPreviews = (fields: string) => parseConfig(valid.replace(`"name": "demo",`, `"name": "demo", ${fields}`)).previews;
    expect(parseConfig(valid).previews).toEqual({ sendEmailTo: [] });
    expect(withPreviews(`"email": true, "previews": { "sendEmailTo": ["*@team.example", "sam@example.com"] },`)).toEqual({ sendEmailTo: ["*@team.example", "sam@example.com"] });
    expect(() => withPreviews(`"previews": { "sendEmailTo": ["*@team.example"] },`)).toThrow(/needs email/);
    for (const bad of ["*", "Sam@example.com", "*.example.com", "@example.com", "a@b"]) {
      expect(() => withPreviews(`"email": true, "previews": { "sendEmailTo": ["${bad}"] },`), bad).toThrow(/sendEmailTo/);
    }
  });

  it("reads auth as on or off, with organizations off unless asked for", () => {
    const withAuth = (auth: string) => parseConfig(valid.replace(`"name": "demo",`, `"name": "demo", "email": true, "auth": ${auth},`)).auth;
    expect(parseConfig(valid).auth).toBe(false);
    expect(withAuth("true")).toEqual({ organizations: false, apiTokens: false, signup: "invite" });
    expect(withAuth(`{ "organizations": true }`)).toEqual({ organizations: true, apiTokens: false, signup: "invite" });
    expect(withAuth(`{ "apiTokens": true }`)).toEqual({ organizations: false, apiTokens: true, signup: "invite" });
  });

  it("no longer takes a migrate command", () => {
    expect(() => parseConfig(valid.replace(`"database": true`, `"database": { "migrate": "x" }`))).toThrow(/database\.migrate/);
  });

  it("upgrades an older file, keeping its comments", () => {
    const old = valid.replace(`"name": "demo",`, `"name": "demo", "version": 1,`).replace(`"database": true`, `"database": { "neonProject": "quiet-meadow-12345678", "migrate": "x" }`);
    const { text, changes, neonProject } = upgradeConfigText(old);
    expect(changes).toEqual(["removed version", "removed database.migrate", "database is now true, its project id moving to NEON_PROJECT_ID"]);
    expect(neonProject).toBe("quiet-meadow-12345678");
    expect(text).toContain("// comments and trailing commas are allowed");
    expect(parseConfig(text)).toMatchObject({ name: "demo", database: true });
    expect(upgradeConfigText(text).changes).toEqual([]);
  });

  it("upgrades a bare frontend folder to { dir, spa: true }, keeping what it served", () => {
    const { text, changes } = upgradeConfigText(`{\n  "name": "x",\n  "frontend": "dist"\n}\n`);
    expect(changes).toEqual(["frontend is now { dir, spa }; spa: true keeps index.html for unknown paths, and removing it makes them 404s"]);
    expect(JSON.parse(text).frontend).toEqual({ dir: "dist", spa: true });
    expect(() => parseConfig(`{ "frontend": "dist" }`)).toThrow(/older shape \(frontend\)/);
  });

  it("rejects unknown keys", () => {
    expect(() => parseConfig(valid.replace(`"name": "demo",`, `"name": "demo", "extra": true,`))).toThrow(/extra/);
  });

  it("keeps app names to 3 to 50 characters with no --, which starts every platform suffix", () => {
    const named = (name: string) => () => parseConfig(valid.replace(`"name": "demo",`, `"name": "${name}",`));
    for (const bad of ["ab", "a--b", "demo-", "-demo", "1demo", "a".repeat(51)]) expect(named(bad)).toThrow(/name:/);
    for (const good of ["abc", "my-app", "app2", "a".repeat(50)]) expect(named(good)).not.toThrow();
  });

  it("tells an older config to upgrade", () => {
    expect(() => parseConfig(valid.replace(`"name": "demo",`, `"version": 1, "name": "demo",`))).toThrow(/older shape \(version\).*platform upgrade/);
  });

  it("reports JSON syntax errors", () => {
    expect(() => parseConfig(`{ "version": `)).toThrow(ConfigError);
  });

  it("lists every invalid field", () => {
    const error = (() => {
      try {
        parseConfig(`{ "name": "Demo", "hostname": "x" }`);
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
  const withVars = valid.replace(`"demo.example.com"`, `"\${APP_HOSTNAME}"`).replace(`"name": "demo"`, `"name": "\${APP_NAME}"`);

  it("lists the variables a config uses", () => {
    expect(configVariables(withVars)).toEqual(["APP_NAME", "APP_HOSTNAME"]);
  });

  it("fills them in before validating", () => {
    const config = parseConfig(withVars, "platform.jsonc", { APP_HOSTNAME: "app.example.com", APP_NAME: "demo" });
    expect(config.hostname).toBe("app.example.com");
    expect(config.name).toBe("demo");
  });

  it("names every missing variable", () => {
    expect(() => parseConfig(withVars, "platform.jsonc", { APP_HOSTNAME: "app.example.com" })).toThrow(/uses APP_NAME;/);
  });

  it("validates the filled-in value", () => {
    expect(() => parseConfig(withVars, "platform.jsonc", { APP_HOSTNAME: "Bad", APP_NAME: "demo" })).toThrow(/hostname:/);
  });
});

describe("configJsonSchema", () => {
  it("produces a schema editors can use", () => {
    expect(configJsonSchema()).toMatchObject({ type: "object", required: expect.arrayContaining(["name", "hostname"]) });
  });
});

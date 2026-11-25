import { describe, expect, test } from "bun:test";
import { isMetaObject } from "@metaobjectsdev/metadata";
import { ConfigModelError, deriveEnvName, misplacedSettingAttrs, readSettings, readVaults } from "../src/index.js";
import { MODEL, loadModel } from "./model.js";

function withSettings(children: unknown[]): unknown {
  return { "metadata.root": { package: "acme::app", children } };
}

async function objects(model: unknown = MODEL) {
  const root = await loadModel(model);
  return root.children().filter(isMetaObject);
}

describe("readSettings", () => {
  test("derives names, reads types, defaults and flags", async () => {
    const groups = readSettings(await objects());
    expect(groups.map((g) => g.name)).toEqual(["Database", "LlmProvider", "Build"]);
    const db = groups[0]!;
    expect(db.description).toBe("The primary database.");
    expect(db.settings).toEqual([
      { envName: "DATABASE_URL", setting: "acme::app::Database.url", type: "string", required: true, secret: true, phase: "runtime", description: "Connection URL." },
      { envName: "DATABASE_USERNAME", setting: "acme::app::Database.username", type: "string", required: true, secret: false, phase: "runtime" },
      { envName: "DB_POOL_SIZE", setting: "acme::app::Database.poolSize", type: "int", required: false, secret: false, phase: "runtime", default: "10" },
    ]);
    expect(groups[1]!.settings.map((s) => [s.envName, s.default])).toEqual([
      ["LLM_PROVIDER_API_KEY", undefined],
      ["LLM_PROVIDER_MODEL", "a model name"],
      ["LLM_PROVIDER_TRACE", "false"],
    ]);
    expect(groups[2]!.settings[0]!.phase).toBe("build");
  });

  test("names every problem a loader cannot see, together", async () => {
    const model = withSettings([
      { "object.settings": { name: "Database", children: [
        { "field.string": { name: "url", "@secret": true, "@default": "postgres://x" } },
        { "field.string": { name: "host", "@envName": "db-host" } },
        { "field.string": { name: "tags", "isArray": true } },
      ] } },
      { "object.settings": { name: "Db", children: [{ "field.string": { name: "x", "@envName": "DATABASE_URL" } }] } },
    ]);
    let err: unknown;
    try {
      readSettings(await objects(model));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigModelError);
    const problems = (err as ConfigModelError).problems.join("\n");
    expect(problems).toContain("acme::app::Database.url: a @secret setting may not declare @default");
    expect(problems).toContain('acme::app::Database.host: @envName "db-host" is not an environment variable name');
    expect(problems).toContain("acme::app::Database.tags: a setting holds one value");
    expect(problems).toContain("acme::app::Db.x: environment variable DATABASE_URL is also acme::app::Database.url");
  });

  test("refuses a derived name that is no variable, a non-scalar field, and invalid settings on an abstract base", async () => {
    const model = withSettings([
      { "object.settings": { name: "Database", children: [{ "field.string": { name: "pool-size" } }] } },
      { "object.value": { name: "Nested", children: [{ "field.object": { name: "inner", "@objectRef": "acme::app::Nested" } }] } },
      { "object.settings": { name: "Api", extends: "Nested" } },
      { "object.settings": { name: "Base", abstract: true, children: [
        { "field.string": { name: "key", "@secret": true, "@default": "x", "@envName": "not-valid" } },
      ] } },
    ]);
    let err: unknown;
    try {
      readSettings(await objects(model));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigModelError);
    const problems = (err as ConfigModelError).problems.join("\n");
    expect(problems).toContain('acme::app::Database.pool-size: the derived environment variable name "DATABASE_POOL-SIZE" is not valid');
    expect(problems).toContain("set @envName");
    expect(problems).toContain("acme::app::Api.inner: a setting is a scalar; field.object is not one of");
    expect(problems).toContain("acme::app::Base.key: a @secret setting may not declare @default");
    expect(problems).toContain('acme::app::Base.key: @envName "not-valid" is not an environment variable name');
  });

  test("an abstract group is read only through the groups that extend it", async () => {
    const groups = readSettings(await objects(withSettings([
      { "object.settings": { name: "Base", abstract: true, children: [{ "field.string": { name: "host" } }] } },
      { "object.settings": { name: "Db", extends: "Base", children: [{ "field.int": { name: "port" } }] } },
    ])));
    expect(groups.map((g) => g.name)).toEqual(["Db"]);
    expect(groups[0]!.settings.map((s) => s.envName).sort()).toEqual(["DB_HOST", "DB_PORT"]);
  });

  test("names setting attributes put on a field of something other than settings", async () => {
    const found = misplacedSettingAttrs(await objects(withSettings([
      { "object.value": { name: "Token", children: [{ "field.string": { name: "value", "@secret": true, "@envName": "TOKEN" } }] } },
      { "object.settings": { name: "Ok", children: [{ "field.string": { name: "x", "@secret": true } }] } },
    ])));
    expect(found).toEqual(["acme::app::Token.value: @secret, @envName only mean something on a field of an object.settings; here nothing reads them"]);
  });

  test("derives upper snake case through acronyms and digits", () => {
    expect(deriveEnvName("Database", "poolSize")).toBe("DATABASE_POOL_SIZE");
    expect(deriveEnvName("OAuth2", "clientID")).toBe("O_AUTH2_CLIENT_ID");
    expect(deriveEnvName("S3", "bucketName")).toBe("S3_BUCKET_NAME");
  });
});

describe("readVaults", () => {
  test("reads scopes, defaulting the store environment to the scope's name", async () => {
    const vaults = readVaults(await loadModel());
    expect(vaults).toEqual([
      {
        name: "keys",
        key: "acme::app::keys",
        product: "infisical",
        defaultScope: { name: "dev", project: "acme-app", env: "dev" },
        scopes: [
          { name: "dev", project: "acme-app", env: "dev" },
          { name: "production", project: "acme-app-prod", env: "prod" },
        ],
      },
    ]);
  });

  test("skips a vault outside the run's scope", async () => {
    const root = await loadModel(withSettings([{ "vault.infisical": { name: "empty" } }]));
    expect(readVaults(root, () => false)).toEqual([]);
  });

  test("refuses a missing default scope, two scopes on one store environment, and a vault with no scope", async () => {
    const model = withSettings([
      { "vault.infisical": { name: "keys", "@defaultScope": "qa", children: [
        { "scope.env": { name: "staging", "@project": "a", "@env": "prod" } },
        { "scope.env": { name: "production", "@project": "b", "@env": "prod" } },
      ] } },
      { "vault.infisical": { name: "empty" } },
    ]);
    const root = await loadModel(model);
    expect(() => readVaults(root)).toThrow(/scopes staging and production both use the store environment "prod"[\s\S]*@defaultScope "qa" names no scope.env of this vault[\s\S]*acme::app::empty: a vault needs at least one scope.env/);
  });
});

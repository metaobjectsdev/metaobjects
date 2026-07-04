import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBaseline, runOfflineGenerate } from "../src/commands/migrate.js";

// #157 — the offline migrate paths (baseline + offline generate) must thread the
// consumer `providers` from metaobjects.config.ts into loadMemory, exactly like
// `meta gen` and the DB migrate paths do. Otherwise a project that registers a
// custom subtype via a config provider hits `Unknown type <subtype>` on offline
// `meta migrate`, forcing a "strip the custom nodes" workaround.

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// A config that registers a custom `validator.geocheck` subtype via a provider —
// mirrors how an adopter ships a custom subtype to gen/migrate. A validator is
// used (not a field) so it exercises provider-threading without also depending on
// how the migrate column-mapper handles a novel physical type.
const CUSTOM_CONFIG = [
  `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
  `import { entityFile } from "@metaobjectsdev/codegen-ts/generators";`,
  `import { TypeId, TYPE_VALIDATOR, MetaValidator } from "@metaobjectsdev/metadata";`,
  `const geoProvider = {`,
  `  id: "test-geocheck",`,
  `  dependencies: ["metaobjects-core-types"],`,
  `  registerTypes(registry) {`,
  `    registry.register({`,
  `      typeId: new TypeId(TYPE_VALIDATOR, "geocheck"),`,
  `      description: "A custom validator",`,
  `      factory: (typeId, name) => new MetaValidator(typeId, name),`,
  `      childRules: [],`,
  `      attributes: [],`,
  `    });`,
  `  },`,
  `};`,
  `export default defineConfig({`,
  `  outDir: "out",`,
  `  dialect: "postgres",`,
  `  generators: [entityFile()],`,
  `  providers: [geoProvider],`,
  `});`,
].join("\n");

// An entity (writable table) whose `name` field carries the custom validator.
// The `validator.geocheck` child resolves ONLY when the config provider loads —
// so an offline migrate that doesn't thread providers fails at metadata load.
const CUSTOM_META = {
  "metadata.root": {
    package: "acme::geo",
    children: [
      {
        "object.entity": {
          name: "Place",
          children: [
            { "field.long": { name: "id" } },
            {
              "field.string": {
                name: "name",
                children: [{ "validator.geocheck": { name: "chk" } }],
              },
            },
            { "source.rdb": { name: "src", "@table": "places" } },
            {
              "identity.primary": {
                name: "pk",
                "@fields": ["id"],
                "@generation": "increment",
              },
            },
          ],
        },
      },
    ],
  },
};

async function customProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-migprov-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(
    join(root, "metaobjects", "meta.json"),
    JSON.stringify(CUSTOM_META),
    "utf8",
  );
  await writeFile(join(root, "metaobjects.config.ts"), CUSTOM_CONFIG, "utf8");
  return root;
}

describe("offline migrate threads config providers (#157)", () => {
  test("runBaseline loads a config-registered custom subtype (no strip workaround)", async () => {
    const root = await customProject();
    const code = await runBaseline(
      { dialect: "postgres", outDir: "./.metaobjects/migrations", fromDb: false } as any,
      root,
    );
    expect(code).toBe(0);
  });

  test("runOfflineGenerate loads a config-registered custom subtype", async () => {
    const root = await customProject();
    // baseline first (also needs the provider) so there is a snapshot to diff.
    await runBaseline(
      { dialect: "postgres", outDir: "./.metaobjects/migrations", fromDb: false } as any,
      root,
    );
    const code = await runOfflineGenerate(
      {
        dialect: "postgres",
        outDir: "./.metaobjects/migrations",
        allow: [],
        onAmbiguous: "error",
      } as any,
      root,
    );
    expect(code).toBe(0);
  });
});

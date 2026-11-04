import { describe, test, expect, afterAll, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCommand } from "../src/commands/export.js";
import { typesCommand } from "../src/commands/types.js";
import { verifyCommand } from "../src/commands/verify.js";
import { runFmt } from "../src/lib/fmt-engine.js";
import { proveDependencySetLoads } from "../src/lib/dependency-load.js";

// A project's own `metaobjects.config.ts` providers must reach EVERY command that loads
// metadata, not just gen/migrate. The vocabulary mirrors the shared conformance fixture
// `provider-custom-vocabulary-success`: a new subtype (`layout.picker @displayField`) and
// two attrs added to `field.string` (`@searchable`, `@valueLabels`).

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const PROVIDER_SRC = [
  `import { TypeId, MetaLayout } from "@metaobjectsdev/metadata";`,
  `import { TYPE_FIELD, TYPE_LAYOUT, FIELD_SUBTYPE_STRING, ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_BOOLEAN } from "@metaobjectsdev/metadata/constants";`,
  `const vocab = {`,
  `  id: "test-custom-vocabulary",`,
  `  dependencies: ["metaobjects-core-types"],`,
  `  registerTypes(registry) {`,
  `    registry.register({`,
  `      typeId: new TypeId(TYPE_LAYOUT, "picker"),`,
  `      description: "A picker over the owning object.",`,
  `      factory: (typeId, name) => new MetaLayout(typeId, name),`,
  `      childRules: [],`,
  `      attributes: [{ name: "displayField", valueType: ATTR_SUBTYPE_STRING, required: false, description: "Field shown per choice." }],`,
  `    });`,
  `    registry.extend(TYPE_FIELD, FIELD_SUBTYPE_STRING, {`,
  `      attributes: [`,
  `        { name: "searchable", valueType: ATTR_SUBTYPE_BOOLEAN, required: false, description: "Offer in search." },`,
  `        { name: "valueLabels", valueType: ATTR_SUBTYPE_STRING, isArray: true, required: false, description: "Display labels." },`,
  `      ],`,
  `    });`,
  `  },`,
  `};`,
].join("\n");

const GOOD_CONFIG = [
  `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
  PROVIDER_SRC,
  `export default defineConfig({ outDir: "out", dialect: "postgres", generators: [], providers: [vocab] });`,
].join("\n");

const BROKEN_CONFIG = `export default (() => { throw new Error("boom-from-config"); })();\n`;

const META = JSON.stringify({
  "metadata.root": {
    package: "examples",
    children: [
      {
        "object.value": {
          name: "Contact",
          children: [
            { "field.string": { name: "name", "@searchable": true } },
            { "field.string": { name: "status", "@valueLabels": ["Active", "On hold"] } },
            { "layout.picker": { name: "contactPicker", "@displayField": "name" } },
          ],
        },
      },
    ],
  },
});

async function project(config: string | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-cfgprov-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.app.json"), META, "utf8");
  if (config !== undefined) await writeFile(join(root, "metaobjects.config.ts"), config, "utf8");
  return root;
}

async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; err: string; out: string }> {
  const errs: string[] = [];
  const outs: string[] = [];
  const e = spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(" ")); });
  const l = spyOn(console, "log").mockImplementation((...a: unknown[]) => { outs.push(a.map(String).join(" ")); });
  try {
    return { result: await fn(), err: errs.join("\n"), out: outs.join("\n") };
  } finally {
    e.mockRestore();
    l.mockRestore();
  }
}

describe("config providers reach every metadata-loading command", () => {
  test("export loads custom vocabulary; without the provider it is refused", async () => {
    const root = await project(GOOD_CONFIG);
    const out = join(root, "export.json");
    const { result } = await captured(() => exportCommand(["--out", out], root));
    expect(result).toBe(0);
    expect(await readFile(out, "utf8")).toContain("layout.picker");

    const bare = await project(undefined);
    const { result: bareCode } = await captured(() => exportCommand(["--out", join(bare, "x.json")], bare));
    expect(bareCode).toBe(1);
  });

  test("export surfaces a broken config as itself", async () => {
    const root = await project(BROKEN_CONFIG);
    const { result, err } = await captured(() => exportCommand([], root));
    expect(result).toBe(1);
    expect(err).toContain("boom-from-config");
  });

  test("meta deps proof loads the full set with the provider (not 'port-only vocabulary')", async () => {
    const root = await project(GOOD_CONFIG);
    expect((await proveDependencySetLoads(root)).scope).toBe("full");
  });

  test("meta fmt finds the config in an ancestor of the collection and in-place", async () => {
    const root = await project(GOOD_CONFIG);
    const r = await runFmt({ projectRoot: root, check: true });
    expect(r.fatal).toBeUndefined();
    expect(r.files.every((f) => f.status !== "error")).toBe(true);
  });

  test("meta fmt run from a sub-project reads that sub-project's config, not the collection's", async () => {
    // The collection (.metaobjects/config.json + metadata) sits at the repo root; the
    // TypeScript config sits in a package below it. Reading the config from the
    // collection's directory (the old behaviour) never saw it.
    const root = await project(undefined);
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".metaobjects"), { recursive: true });
    await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1 }), "utf8");
    const app = join(root, "app");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "metaobjects.config.ts"), GOOD_CONFIG, "utf8");
    const r = await runFmt({ projectRoot: app, check: true });
    expect(r.fatal).toBeUndefined();
    expect(r.files.length).toBeGreaterThan(0);
    expect(r.files.every((f) => f.status !== "error")).toBe(true);
  });

  test("meta fmt reports a broken config instead of dropping providers", async () => {
    const root = await project(BROKEN_CONFIG);
    const r = await runFmt({ projectRoot: root, check: true });
    expect(r.fatal).toContain("boom-from-config");
  });

  test("meta types lists project vocabulary when a config is present", async () => {
    const root = await project(GOOD_CONFIG);
    const prev = process.cwd();
    process.chdir(root);
    try {
      const { result, out } = await captured(() => typesCommand(["layout.picker"]));
      expect(result).toBe(0);
      expect(out).toContain("layout.picker");
      const attrs = await captured(() => typesCommand(["searchable"]));
      expect(attrs.out).toContain("searchable");
    } finally {
      process.chdir(prev);
    }
  });

  test("meta types is unchanged with no config", async () => {
    const root = await project(undefined);
    const prev = process.cwd();
    process.chdir(root);
    try {
      const { out } = await captured(() => typesCommand(["layout.picker"]));
      expect(out).not.toContain("layout.picker  ");
      expect(out.toLowerCase()).toContain("no vocabulary matches");
    } finally {
      process.chdir(prev);
    }
  });

  test("strict verify passes custom vocabulary with the provider and surfaces a broken config", async () => {
    const root = await project(GOOD_CONFIG);
    const ok = await captured(() => verifyCommand(["--templates"], root));
    expect(ok.err).not.toContain("ERR_UNKNOWN");
    expect(ok.result).toBe(0);

    const broken = await project(BROKEN_CONFIG);
    const bad = await captured(() => verifyCommand(["--templates"], broken));
    expect(bad.result).toBe(2);
    expect(bad.err).toContain("boom-from-config");
    expect(bad.err).not.toContain("ERR_UNKNOWN_SUBTYPE");
  });
});

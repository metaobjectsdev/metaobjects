import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsCommand } from "../../src/commands/docs.js";

// One entity (object.value Widget) so both the model surface (Widget.md +
// README.md) and the api surface (api/Widget.md) have a unit to document.
const META = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.value": {
          name: "Widget",
          children: [
            { "field.string": { name: "name" } },
            { "field.string": { name: "color" } },
          ],
        },
      },
    ],
  },
};

// A minimal valid metaobjects.config.ts (no custom types) — its presence is what
// gates the api surface (api docs describe the GENERATED REST surface, which only
// exists when there is a gen config).
const CONFIG = [
  `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
  `export default defineConfig({`,
  `  outDir: "out",`,
  `  dialect: "sqlite",`,
  `  generators: ["entity"],`,
  `});`,
].join("\n");

// A config with a persisted entity but NO `dialect`. Every SQL type on `agent/schema.md`
// is dialect-specific, so the page cannot be built truthfully without one.
const CONFIG_NO_DIALECT = [
  `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
  `export default defineConfig({`,
  `  outDir: "out",`,
  `  generators: ["entity"],`,
  `});`,
].join("\n");

// An entity with a table, so there IS a physical schema for the page to describe.
const META_PERSISTED = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Widget",
          children: [
            { "source.rdb": { "@table": "widgets" } },
            { "field.long": { name: "id", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            { "field.string": { name: "name" } },
          ],
        },
      },
    ],
  },
};

// A config whose docs block declares TWO api surfaces: one this port owns
// (lang "ts") and one another port owns (lang "java"). This command should emit
// only the owned (ts) surface but link BOTH from the model page.
const CONFIG_TWO_SURFACES = [
  `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
  `export default defineConfig({`,
  `  outDir: "out",`,
  `  dialect: "sqlite",`,
  `  generators: ["entity"],`,
  `  docs: {`,
  `    apiSurfaces: [`,
  `      { lang: "ts", subDir: "api/ts" },`,
  `      { lang: "java", subDir: "api/java" },`,
  `    ],`,
  `  },`,
  `});`,
].join("\n");

const dirs: string[] = [];

/** Project root with metadata + a metaobjects.config.ts present. */
async function projectWithConfig(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-docs-surf-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.json"), JSON.stringify(META), "utf8");
  await writeFile(join(root, "metaobjects.config.ts"), CONFIG, "utf8");
  return root;
}

/** Project root whose docs config declares two api surfaces (ts + java). */
async function projectTwoSurfaces(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-docs-surf-2-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.json"), JSON.stringify(META), "utf8");
  await writeFile(join(root, "metaobjects.config.ts"), CONFIG_TWO_SURFACES, "utf8");
  return root;
}

/** Project root with metadata but NO metaobjects.config.ts. */
async function projectNoConfig(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-docs-surf-nocfg-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.json"), JSON.stringify(META), "utf8");
  return root;
}

/** Project root with a persisted entity and a config, with or without a `dialect`. */
async function projectPersisted(config: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-docs-surf-dialect-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.json"), JSON.stringify(META_PERSISTED), "utf8");
  await writeFile(join(root, "metaobjects.config.ts"), config, "utf8");
  return root;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("meta docs — model + api surfaces from one docs: config", () => {
  test("emits BOTH surfaces when a config is present", async () => {
    const root = await projectWithConfig();
    const out = join(root, "out-both");

    const code = await docsCommand([root, "--out", out], root);
    expect(code).toBe(0);

    // Model surface.
    expect(existsSync(join(out, "Widget.md"))).toBe(true);
    expect(existsSync(join(out, "README.md"))).toBe(true);
    // Api surface, side by side under api/.
    expect(existsSync(join(out, "api", "Widget.md"))).toBe(true);
  });

  test("--model emits ONLY the model surface (no api dir)", async () => {
    const root = await projectWithConfig();
    const out = join(root, "out-model-only");

    const code = await docsCommand([root, "--out", out, "--model"], root);
    expect(code).toBe(0);

    expect(existsSync(join(out, "Widget.md"))).toBe(true);
    expect(existsSync(join(out, "api"))).toBe(false);
  });

  test("emits only the owned (ts) surface but links ALL declared surfaces", async () => {
    const root = await projectTwoSurfaces();
    const out = join(root, "out-two");

    const code = await docsCommand([root, "--out", out], root);
    expect(code).toBe(0);

    // TS surface IS emitted (this port owns lang "ts"):
    expect(existsSync(join(out, "api", "ts", "Widget.md"))).toBe(true);
    // Java surface is NOT emitted by THIS command:
    expect(existsSync(join(out, "api", "java"))).toBe(false);
    // the model entity page links BOTH surfaces:
    const page = readFileSync(join(out, "Widget.md"), "utf8");
    expect(page).toContain("api/ts/");
    expect(page).toContain("api/java/");
  });

  test("no config → model surface only, exit 0 (api skipped)", async () => {
    const root = await projectNoConfig();
    const out = join(root, "out-nocfg");

    const code = await docsCommand([root, "--out", out], root);
    expect(code).toBe(0);

    expect(existsSync(join(out, "Widget.md"))).toBe(true);
    expect(existsSync(join(out, "api"))).toBe(false);
  });
});

describe("meta docs — the agent schema page and the project's dialect", () => {
  test("emits agent/schema.md under the dialect the CONFIG declares", async () => {
    const root = await projectPersisted(CONFIG);
    const out = join(root, "out-dialect");
    expect(await docsCommand([root, "--out", out], root)).toBe(0);
    const page = readFileSync(join(out, "agent", "schema.md"), "utf8");
    expect(page).toContain("The physical shape of the `sqlite` database");
  });

  test("a PERSISTED model with no dialect gets no schema page — `meta gen` refuses it too", async () => {
    const root = await projectPersisted(CONFIG_NO_DIALECT);
    const out = join(root, "out-nodialect");
    // `DEFAULT_DIALECT` is INERT: `runGen` throws when a model emits database code and no
    // dialect is declared, and it throws BEFORE `normalizeConfig` applies that default, so
    // that a DB project which forgot one is never handed silently-defaulted output. This
    // `Widget` declares a `source.rdb`, so it is exactly such a project — documenting a
    // sqlite schema for it would describe a database `meta gen` will not build.
    expect(await docsCommand([root, "--out", out], root)).toBe(0);
    expect(existsSync(join(out, "agent", "schema.md"))).toBe(false);
    expect(existsSync(join(out, "agent", "ui.md"))).toBe(true);
  });

  test("a model with NO persisted object needs no dialect, and has no schema to describe", async () => {
    // The projects the runner's guard lets through: `DEFAULT_DIALECT` applies, and the page
    // renders empty anyway because there are no tables — so the inert default is inert
    // here too. This is the arm that makes the skip above a narrow rule rather than
    // "no dialect, no page".
    const root = await projectWithConfig(); // META = one sourceless object.value
    const out = join(root, "out-valueonly");
    expect(await docsCommand([root, "--out", out], root)).toBe(0);
    expect(existsSync(join(out, "agent", "schema.md"))).toBe(false);
  });
});

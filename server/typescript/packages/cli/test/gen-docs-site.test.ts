// The docs site as a generator (`docsSiteFile()`, ADR-0034 Amendment 9; `meta docs --site`
// until 1.1.0). The site loads the model with a loader of its own, over whole source
// directories, so what `meta gen` hands it is what these cases hold to: the project's own
// providers, every declared source directory, and output that depends on the model alone.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

const META = {
  "metadata.root": {
    package: "acme::site",
    children: [
      {
        "object.value": {
          name: "Welcome",
          children: [{ "field.string": { name: "name" } }, { "field.string": { name: "headline" } }],
        },
      },
    ],
  },
};

const SHARED_META = {
  "metadata.root": {
    package: "acme::shared",
    children: [{ "object.value": { name: "SharedThing", children: [{ "field.string": { name: "label" } }] } }],
  },
};

const CUSTOM_META = {
  "metadata.root": {
    package: "acme::geo",
    children: [
      {
        "object.value": {
          name: "Place",
          children: [
            { "field.string": { name: "name" } },
            // Resolves ONLY when the config's geopoint provider is loaded.
            { "field.geopoint": { name: "location" } },
          ],
        },
      },
    ],
  },
};

const SITE_ONLY = `
export default defineConfig({
  outDir: "out",
  dialect: "sqlite",
  targets: { docs: { outDir: "docs-out" } },
  generators: [docsSiteFile()],
  PROVIDERS
});
`;

function config(providers: string, extra = ""): string {
  return [
    `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
    `import { docsSiteFile } from "@metaobjectsdev/codegen-ts/generators";`,
    extra,
    SITE_ONLY.replace("PROVIDERS", providers),
  ].join("\n");
}

const GEO_PROVIDER = [
  `import { TypeId, TYPE_FIELD, MetaField } from "@metaobjectsdev/metadata";`,
  `const geoProvider = {`,
  `  id: "test-geo",`,
  `  dependencies: ["metaobjects-core-types"],`,
  `  registerTypes(registry) {`,
  `    registry.register({`,
  `      typeId: new TypeId(TYPE_FIELD, "geopoint"),`,
  `      description: "A geographic point field",`,
  `      factory: (typeId, name) => new MetaField(typeId, name),`,
  `      childRules: [],`,
  `      attributes: [],`,
  `    });`,
  `  },`,
  `};`,
].join("\n");

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function project(meta: object, configSource: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-gen-site-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.json"), JSON.stringify(meta), "utf8");
  await writeFile(join(root, "metaobjects.config.ts"), configSource, "utf8");
  return root;
}

describe("meta gen with docsSiteFile()", () => {
  test("threads the config's providers into the site's own loader, so a custom subtype renders", async () => {
    const root = await project(CUSTOM_META, config("providers: [geoProvider],", GEO_PROVIDER));
    expect(await run(["gen", "--cwd", root])).toBe(0);
    expect(existsSync(join(root, "docs-out", "site", "acme", "geo", "Place.html"))).toBe(true);
  });

  test("two declared sources sharing a basename are both in the site", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "meta-gen-site-multi-"));
    dirs.push(workspace);
    const root = join(workspace, "app");
    await mkdir(join(root, ".metaobjects"), { recursive: true });
    await mkdir(join(root, "metaobjects"), { recursive: true });
    await writeFile(join(root, "metaobjects", "meta.json"), JSON.stringify(META), "utf8");
    await mkdir(join(workspace, "shared-model", "metaobjects"), { recursive: true });
    await writeFile(join(workspace, "shared-model", "metaobjects", "meta.json"), JSON.stringify(SHARED_META), "utf8");
    await writeFile(
      join(root, ".metaobjects", "config.json"),
      JSON.stringify({ schema_version: 1, sources: [{ path: "metaobjects" }, { path: "../shared-model/metaobjects" }] }),
      "utf8",
    );
    await writeFile(join(root, "metaobjects.config.ts"), config(""), "utf8");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    const site = join(root, "docs-out", "site");
    for (const [pkg, model] of [["site", "Welcome"], ["shared", "SharedThing"]] as const) {
      expect(existsSync(join(site, "acme", pkg, `${model}.html`))).toBe(true);
      expect(await readFile(join(site, "acme", pkg, "index.html"), "utf8")).toContain(model);
    }
  });

  test("the pages depend on the model alone: a second run is byte-identical and verify is clean", async () => {
    const root = await project(META, config(""));
    expect(await run(["gen", "--cwd", root])).toBe(0);
    const first = await readFile(join(root, "docs-out", "site", "index.html"), "utf8");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    expect(await readFile(join(root, "docs-out", "site", "index.html"), "utf8")).toBe(first);
    expect(await run(["verify", "--codegen", "--cwd", root])).toBe(0);
  });
});

// Tests for the independent-pack tooling (ADR-0069): the pack.json check, the boundary
// gate, the pinned vocabulary with its "leaves core alone" check, and pack conformance.
//
// Every case builds a throwaway repository root under $DEV_SCRATCH holding one or two
// packs, so nothing here writes into the working tree. The throwaway pack's provider
// imports the metadata package's SOURCE by absolute path, as a workspace pack resolves
// it, which keeps one copy of the metamodel classes in the process.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bounded, checkPackManifests } from "./check-pack-manifests.js";
import { scanCore, scanRegistry, scanReleaseTooling } from "./check-pack-boundary.js";
import { checkPackVocabulary } from "./pack-vocabulary.js";
import { runPackConformance } from "./pack-conformance.js";
import { PACK_VOCABULARY, REPO_ROOT } from "./lib/packs.js";

const METADATA_SRC = join(REPO_ROOT, "server/typescript/packages/metadata/src/index.ts");
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function scratchRoot(): string {
  const r = mkdtempSync(join(process.env.DEV_SCRATCH ?? tmpdir(), "mo-packs-test-"));
  roots.push(r);
  return r;
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** A provider in the shape a pack ships: a new layout subtype plus two optional field.string attrs. */
function providerSource(id: string, opts: { breakCore?: boolean; requireOnCore?: boolean } = {}): string {
  return `import { TypeId, MetaLayout } from ${JSON.stringify(METADATA_SRC)};
export const provider = {
  id: ${JSON.stringify(id)},
  dependencies: ["metaobjects-core-types"],
  registerTypes(registry) {
    registry.register({
      typeId: new TypeId("layout", "picker"),
      description: "A picker that chooses one row of the owning object.",
      factory: (typeId, name) => new MetaLayout(typeId, name),
      childRules: [],
      attributes: [{ name: "displayField", valueType: "string", required: false, description: "Field shown for each choice." }],
    });
    registry.extend("field", "string", {
      attributes: [
        { name: "searchable", valueType: "boolean", required: false, description: "Offer this field in search." },
        { name: "valueLabels", valueType: "string", isArray: true, required: false, description: "Display labels for the field's values." },
      ],
    });
    ${opts.breakCore === true ? `registry.setDefaultSubType("object", "value");` : ""}
    ${opts.requireOnCore === true ? `registry.extend("object", "entity", { childRules: [{ childType: "layout", childSubType: "picker", childName: "*", min: 1 }] });` : ""}
  },
};
`;
}

/** A complete, valid TypeScript-only pack named `name` under `root`. */
function makePack(root: string, name: string, opts: { breakCore?: boolean; requireOnCore?: boolean; manifest?: Record<string, unknown>; pkg?: Record<string, unknown> } = {}): void {
  const base = `packs/${name}`;
  write(root, `${base}/pack.json`, json({
    id: `metaobjects-${name}`,
    version: "0.1.0",
    stability: "preview",
    requires: { metamodel: ">=1.3 <2", packs: {} },
    ports: { typescript: { package: `@metaobjectsdev/pack-${name}`, core: ">=1.3.0 <2.0.0", publish: false } },
    ...opts.manifest,
  }));
  write(root, `${base}/README.md`, `# ${name}\n`);
  write(root, `${base}/CHANGELOG.md`, `# Changelog\n`);
  write(root, `${base}/typescript/package.json`, json({
    name: `@metaobjectsdev/pack-${name}`,
    version: "0.1.0",
    private: true,
    type: "module",
    exports: { ".": { bun: "./src/index.ts", default: "./src/index.ts" } },
    scripts: { typecheck: "tsc --noEmit" },
    peerDependencies: { "@metaobjectsdev/metadata": ">=1.3.0 <2.0.0" },
    devDependencies: { "@metaobjectsdev/metadata": "workspace:*" },
    ...opts.pkg,
  }));
  write(root, `${base}/typescript/src/index.ts`, providerSource(`metaobjects-${name}`, opts));
  write(root, `${base}/${PACK_VOCABULARY}`, "{}\n");
}

describe("pack.json check", () => {
  test("a range is bounded in every registry's own spelling", () => {
    for (const r of [">=1.3.0 <2.0.0", ">=1.3,<2", "^1.3.0", "~1.3", "~=1.3", "[1.3.0,2.0.0)", "(1.3,2.0]"]) expect(bounded(r)).toBe(true);
    for (const r of [">=1.3.0", "[1.3.0,)", "*", "1.3.0"]) expect(bounded(r)).toBe(false);
  });

  test("a complete pack passes", () => {
    const root = scratchRoot();
    makePack(root, "demo");
    expect(checkPackManifests(root)).toEqual([]);
  });

  test("an empty packs/ (or none) passes", () => {
    expect(checkPackManifests(scratchRoot())).toEqual([]);
  });

  test("each disagreement with the native manifest is named", () => {
    const root = scratchRoot();
    makePack(root, "demo", {
      manifest: { id: "demo", requires: { metamodel: ">=1.3", packs: { "metaobjects-nope": ">=0.1.0 <0.2.0" } } },
      pkg: {
        version: "0.2.0",
        private: false,
        peerDependencies: {},
        dependencies: { "@metaobjectsdev/codegen-ts": "^1.3.0" },
        scripts: {},
      },
    });
    mkdirSync(join(root, "packs/demo/python"));
    const problems = checkPackManifests(root).join("\n");
    expect(problems).toContain('id is "demo", must be "metaobjects-demo"');
    expect(problems).toContain("requires.metamodel \">=1.3\" must be a range with an upper bound");
    expect(problems).toContain('requires pack "metaobjects-nope", which is not in packs/');
    expect(problems).toContain('version is "0.2.0", pack.json says "0.1.0"');
    expect(problems).toContain('"private" must be true while pack.json says publish: false');
    expect(problems).toContain('peerDependencies["@metaobjectsdev/metadata"] is "undefined"');
    expect(problems).toContain('"@metaobjectsdev/codegen-ts" is a dependency');
    expect(problems).toContain('needs a "typecheck" script');
    expect(problems).toContain("packs/demo/python: the directory exists but pack.json does not list the port");
  });

  test("the naming rule fixes each registry coordinate", () => {
    const root = scratchRoot();
    makePack(root, "data-flow", {
      manifest: {
        ports: {
          typescript: { package: "@metaobjectsdev/pack-data-flow", core: ">=1.3.0 <2.0.0", publish: false },
          csharp: { package: "MetaObjects.Packs.Dataflow", core: "[1.3.0,2.0.0)", publish: false },
        },
      },
    });
    write(root, "packs/data-flow/csharp/MetaObjects.Packs.DataFlow.csproj",
      `<Project><PropertyGroup><PackageId>MetaObjects.Packs.Dataflow</PackageId><Version>0.1.0</Version></PropertyGroup>` +
      `<ItemGroup><PackageReference Include="MetaObjects" Version="[1.3.0,2.0.0)" /></ItemGroup></Project>`);
    const problems = checkPackManifests(root).join("\n");
    expect(problems).toContain('the naming rule gives "MetaObjects.Packs.DataFlow"');
    expect(problems).not.toContain("MetaObjects reference");
  });

  test("a missing README, changelog or pin is named", () => {
    const root = scratchRoot();
    makePack(root, "demo");
    rmSync(join(root, "packs/demo/CHANGELOG.md"));
    rmSync(join(root, `packs/demo/${PACK_VOCABULARY}`));
    const problems = checkPackManifests(root).join("\n");
    expect(problems).toContain("packs/demo/CHANGELOG.md: missing");
    expect(problems).toContain(`packs/demo/${PACK_VOCABULARY}: missing`);
  });
});

describe("pack boundary", () => {
  test("core naming a pack coordinate, reaching into packs/ or naming a pack id fails", () => {
    const root = scratchRoot();
    makePack(root, "demo");
    write(root, "server/typescript/packages/cli/src/a.ts", `import { x } from "@metaobjectsdev/pack-demo";\n`);
    write(root, "server/python/src/b.py", `PATH = "../../packs/demo/python"\n`);
    write(root, "fixtures/conformance/x/providers.json", `["metaobjects-core-types", "metaobjects-demo"]\n`);
    write(root, "docs/packs.md", "@metaobjectsdev/pack-demo is described here, which is fine\n");
    const problems = scanCore(root).join("\n");
    expect(problems).toContain("server/typescript/packages/cli/src/a.ts:1: core names a pack coordinate");
    expect(problems).toContain("server/python/src/b.py:1: core reaches into packs/ by path");
    expect(problems).toContain('fixtures/conformance/x/providers.json:1: names the independent pack provider "metaobjects-demo"');
    expect(problems).not.toContain("docs/packs.md");
  });

  test("a file named like a pack id is not the id", () => {
    const root = scratchRoot();
    makePack(root, "demo");
    write(root, "server/typescript/packages/cli/src/c.ts", `import { x } from "./metaobjects-demo.js";\n`);
    write(root, "server/python/src/d.py", `SCHEMA = "metaobjects-demo.schema.json"\n`);
    write(root, "server/python/src/e.py", "# The provider is metaobjects-demo.\n");
    write(root, "server/python/src/f.py", "ID = metaobjects-demo.provider\n");
    write(root, "server/typescript/packages/cli/test/g.ts", `import "../src/metaobjects-demo.test.ts";\n`);
    const problems = scanCore(root).join("\n");
    expect(problems).not.toContain("c.ts");
    expect(problems).not.toContain("d.py");
    expect(problems).not.toContain("g.ts");
    expect(problems).toContain('server/python/src/e.py:1: names the independent pack provider "metaobjects-demo"');
    expect(problems).toContain('server/python/src/f.py:1: names the independent pack provider "metaobjects-demo"');
  });

  test("the root workspace may hold the pack glob, and core's scripts may not filter on '*'", () => {
    const root = scratchRoot();
    write(root, "package.json", json({
      workspaces: ["server/typescript/packages/*", "packs/*/typescript", "packs/demo"],
      scripts: { build: "bun run --filter '*' build", typecheck: "bun run --filter './server/typescript/packages/*' typecheck" },
    }));
    const problems = scanCore(root);
    expect(problems).toEqual([
      'package.json: workspace "packs/demo" — packs join only as "packs/*/typescript"',
      "package.json: the \"build\" script must name core's workspace directories, not '*' (which takes in every pack)",
    ]);
  });

  test("a pack id or a pinned type in the bundle's registry fails", () => {
    const root = scratchRoot();
    makePack(root, "demo");
    write(root, "packs/demo/" + PACK_VOCABULARY, json({ types: [{ type: "layout", subType: "picker" }] }));
    write(root, "fixtures/registry-conformance/expected-registry.json", json({ types: [{ type: "layout", subType: "picker" }] }));
    write(root, "fixtures/registry-conformance/providers.json", json({ providers: { "metaobjects-demo": {} } }));
    const problems = scanRegistry(root).join("\n");
    expect(problems).toContain('provider id "metaobjects-demo" is a bundled provider');
    expect(problems).toContain("layout.picker is also in expected-registry.json");
  });

  test("a release gate that starts enumerating packs/ fails", () => {
    const root = scratchRoot();
    const copy = (rel: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      cpSync(join(REPO_ROOT, rel), join(root, rel), { recursive: true });
    };
    for (const rel of ["scripts/publish-set.mjs", "scripts/check-publish-intent.sh", "scripts/check-no-prerelease-versions.sh",
      "server/python/pyproject.toml", "server/csharp/Directory.Build.props", "server/java/pom.xml"]) copy(rel);
    for (const ws of ["server/typescript/packages", "client/web/packages"]) {
      for (const n of readdirSync(join(REPO_ROOT, ws))) {
        try { copy(`${ws}/${n}/package.json`); } catch { /* a directory with no manifest */ }
      }
    }
    expect(scanReleaseTooling(root)).toEqual([]);
    const intent = join(root, "scripts/check-publish-intent.sh");
    writeFileSync(intent, readFileSync(intent, "utf8").replace(
      "client/web/packages/*/package.json; do", "client/web/packages/*/package.json packs/*/typescript/package.json; do"));
    const problems = scanReleaseTooling(root).join("\n");
    expect(problems).toContain("scripts/check-publish-intent.sh: fails once a pack package exists under packs/");
  });
});

describe("pack vocabulary", () => {
  test("the pin holds exactly what the pack adds, and it leaves core alone", async () => {
    const root = scratchRoot();
    makePack(root, "demo");
    const r = await checkPackVocabulary("demo", root);
    const pin = JSON.parse(r.emitted) as {
      pack: string;
      types: { type: string; subType: string }[];
      extends: { type: string; subType: string; attrs: { name: string }[] }[];
      commonAttrs: unknown[];
    };
    expect(pin.pack).toBe("metaobjects-demo");
    expect(pin.types.map((t) => `${t.type}.${t.subType}`)).toEqual(["layout.picker"]);
    expect(pin.extends.map((e) => `${e.type}.${e.subType}:${e.attrs.map((a) => a.name).join(",")}`)).toEqual(["field.string:searchable,valueLabels"]);
    expect(pin.commonAttrs).toEqual([]);
    // Only the stale-pin problem: the committed placeholder is not the derived pin.
    expect(r.problems).toEqual([`${PACK_VOCABULARY} is stale — the registered vocabulary changed; review it and run: bun scripts/pack-vocabulary.ts demo --write`]);
    writeFileSync(join(root, "packs/demo", PACK_VOCABULARY), r.emitted);
    expect((await checkPackVocabulary("demo", root)).problems).toEqual([]);
  });

  test("a pack that changes a row the bundle declares does not leave core alone", async () => {
    const root = scratchRoot();
    makePack(root, "demo", { breakCore: true });
    const problems = (await checkPackVocabulary("demo", root)).problems.join("\n");
    expect(problems).toContain("does not leave core alone — changed: default object");
  });

  test("a pack that adds a required child rule to a bundle type does not leave core alone (ADR-0050)", async () => {
    const root = scratchRoot();
    makePack(root, "demo", { requireOnCore: true });
    const problems = (await checkPackVocabulary("demo", root)).problems.join("\n");
    expect(problems).toContain("does not leave core alone — required: child object.entity > layout.picker:* (min 1)");
  });

  test("a pack is pinned only for its own rows when it requires another pack", async () => {
    const root = scratchRoot();
    makePack(root, "base");
    makePack(root, "child", { manifest: { requires: { metamodel: ">=1.3 <2", packs: { "metaobjects-base": ">=0.1.0 <0.2.0" } } } });
    // The child registers nothing of its own: same body as base would collide, so give it none.
    write(root, "packs/child/typescript/src/index.ts",
      `export const provider = { id: "metaobjects-child", dependencies: ["metaobjects-base"], registerTypes() {} };\n`);
    const pin = JSON.parse((await checkPackVocabulary("child", root)).emitted) as { types: unknown[]; extends: unknown[] };
    expect(pin.types).toEqual([]);
    expect(pin.extends).toEqual([]);
  });
});

describe("pack conformance", () => {
  const MODEL = join(REPO_ROOT, "fixtures/conformance/provider-custom-vocabulary-success");

  test("a pack's corpus runs through the TypeScript adapter with the pack composed in", async () => {
    const root = scratchRoot();
    makePack(root, "demo");
    const corpus = "packs/demo/fixtures/conformance";
    cpSync(join(MODEL, "input"), join(root, corpus, "loads/input"), { recursive: true });
    cpSync(join(MODEL, "expected.json"), join(root, corpus, "loads/expected.json"));
    write(root, `${corpus}/loads/providers.json`, json(["metaobjects-core-types", "metaobjects-demo"]));
    const r = await runPackConformance("demo", root);
    expect(r?.passed).toBe(true);
    expect(r?.fixtures.map((f) => `${f.name}:${f.status}`)).toEqual(["loads:pass"]);
  });

  test("a scenario that does not name the pack fails, and a pack with no corpus reports none", async () => {
    const root = scratchRoot();
    makePack(root, "demo");
    expect(await runPackConformance("demo", root)).toBeUndefined();
    const corpus = "packs/demo/fixtures/conformance";
    cpSync(join(MODEL, "input"), join(root, corpus, "core-only/input"), { recursive: true });
    cpSync(join(MODEL, "expected.json"), join(root, corpus, "core-only/expected.json"));
    const r = await runPackConformance("demo", root);
    expect(r?.passed).toBe(false);
    expect(r?.fixtures[0]?.problems.join(" ")).toContain('providers.json must name "metaobjects-demo"');
  });
});

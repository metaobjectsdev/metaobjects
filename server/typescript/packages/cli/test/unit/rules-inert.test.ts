// ADR-0066 — the business-rules vocabulary generates nothing yet.
//
// 1.3.0 registers `api.operational`, `operation.*`, `binding.rest` and `transition.action`,
// with their loader rules and `verify` checks. The generated services and enforcing shells
// that act on them are later work, so until they land every generator, every documentation
// page and `meta migrate` must produce byte-identical output for a model with the vocabulary
// and the same model without it. A generator that started reading an operation or a
// transition by accident would emit something half-built; this test is what notices.
//
// The model pair lives in fixtures/codegen-noop/rules/ and is shared with the other four
// ports' copies of this test.
//
// One generator is held to a different line: `docs-site`, the model explorer, lists every
// node of the model in its data payload, so it lists the new nodes too. Its other output is
// byte-identical, and the payload differs by exactly the `api`, `operation`, `binding` and
// `transition` nodes.
//
// The generators of the rules layers themselves (ADR-0067) are the other exception: reading the
// vocabulary is what they are for. Each emits nothing for the model without it, and only files of
// its own for the model with it, so it adds files and moves none.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadUris, TYPE_API, type MetaRoot } from "@metaobjectsdev/metadata";
import { runGen, buildProjectionViews, type Generator, type MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";
import { buildExpectedSchema } from "@metaobjectsdev/migrate-ts";
import { composeCatalog } from "../../src/lib/catalog.js";

// test/unit → cli → packages → typescript → server → repo root
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const MODELS = join(REPO_ROOT, "fixtures", "codegen-noop", "rules");
const GEN_STATE = ".gen-state";

// Both variants load from ONE path, and every run writes under ONE project root: the
// documentation pages print the source file and the project's directory name, and those must
// not be what differs.
const SCRATCH = mkdtempSync(join(tmpdir(), "rules-inert-"));
const MODEL_FILE = join(SCRATCH, "model", "meta.purchasing.json");
const PROJECT = join(SCRATCH, "project");

async function load(variant: "with" | "without"): Promise<MetaRoot> {
  mkdirSync(join(SCRATCH, "model"), { recursive: true });
  copyFileSync(join(MODELS, variant, "meta.purchasing.json"), MODEL_FILE);
  const file = MODEL_FILE;
  const result = await loadUris([pathToFileURL(file).href]);
  if (result.errors.length > 0) {
    throw new Error(`${file} did not load:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

function walkFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkFiles(root, abs));
    else out.push(relative(root, abs));
  }
  return out.sort();
}

async function emit(metadata: MetaRoot, generators: Generator[]): Promise<Record<string, string>> {
  const root = PROJECT;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const config: MetaobjectsGenConfig = {
    outDir: "src/generated",
    extStyle: "js",
    dialect: "postgres",
    dbImport: "../db",
    targets: { docs: { outDir: "src/generated" } },
    generators,
  };
  try {
    await runGen({ config, metadata, projectRoot: root, genStateDir: join(root, GEN_STATE) });
    const files: Record<string, string> = {};
    for (const rel of walkFiles(root)) {
      if (rel.split(sep)[0] === GEN_STATE) continue;
      files[rel] = readFileSync(join(root, rel), "utf8");
    }
    return files;
  } catch (e) {
    return { "<threw>": e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const DOCS_SITE = "docs-site";
/** The ADR-0067 rules-layer generators, and the files the vocabulary ADDS to each one's output. */
const RULES_LAYER: Record<string, string[]> = {
  "rules-names": ["src/generated/acme/purchasing/rules.names.ts"],
  // Its entity contracts and error bodies do not depend on the vocabulary; the operations do, and
  // so does the value object only an operation reaches.
  "contract-types": [
    "src/generated/DecisionInput.ts",
    "src/generated/acme/purchasing/operations.contract.ts",
  ],
};

/**
 * The ADR-0067 service generators: the enforcing shells, so the vocabulary is what they act on.
 * Each pins the files the vocabulary ADDS (a command per derived transition, a shell per declared
 * operation) and the files it CHANGES (the index's interfaces, the lifecycle entity's create and
 * update, which check its state, and the transport's routes); every other file stays byte-identical.
 */
const SERVICE_LAYER: Record<string, { added: string[]; changed: string[] }> = {
  service: {
    // `approve` and `reject` are claimed by `decide`, so only `submit` derives a command.
    added: [
      "src/generated/acme/purchasing/service/decide.ts",
      "src/generated/acme/purchasing/service/openRequests.ts",
      "src/generated/acme/purchasing/service/requestSummary.ts",
      "src/generated/acme/purchasing/service/submitPurchaseRequest.ts",
    ],
    changed: [
      "src/generated/acme/purchasing/service/createPurchaseRequest.ts",
      "src/generated/acme/purchasing/service/index.ts",
      "src/generated/acme/purchasing/service/updatePurchaseRequest.ts",
    ],
  },
  "service-routes": { added: [], changed: ["src/generated/acme/purchasing/transport/fastify.ts"] },
  "service-routes-hono": { added: [], changed: ["src/generated/acme/purchasing/transport/hono.ts"] },
};

let withRules: MetaRoot;
let withoutRules: MetaRoot;

beforeAll(async () => {
  withRules = await load("with");
  withoutRules = await load("without");
});

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("ADR-0066 the business-rules vocabulary is inert in every generator and in migrate", () => {
  test("the with-model really carries the vocabulary (else every check below is vacuous)", () => {
    expect(withRules.children().some((c) => c.type === TYPE_API)).toBe(true);
    expect(withoutRules.children().some((c) => c.type === TYPE_API)).toBe(false);
  });

  const catalog = composeCatalog();
  for (const [name, entry] of Object.entries(catalog)) {
    if (name === DOCS_SITE || name in RULES_LAYER || name in SERVICE_LAYER) continue;
    test(`generator "${name}" emits the same files, byte for byte`, async () => {
      const expected = await emit(withoutRules, [entry.factory()]);
      const actual = await emit(withRules, [entry.factory()]);
      expect(actual).toEqual(expected);
    });
  }

  for (const [name, files] of Object.entries(RULES_LAYER)) {
    test(`rules-layer generator "${name}" adds only its own files for the vocabulary, and moves none`, async () => {
      const expected = await emit(withoutRules, [catalog[name]!.factory()]);
      const actual = await emit(withRules, [catalog[name]!.factory()]);
      expect(expected["<threw>"]).toBeUndefined();
      expect(Object.keys(actual).filter((p) => !(p in expected)).sort()).toEqual(files);
      for (const p of files) delete actual[p];
      expect(actual).toEqual(expected);
    });
  }

  for (const [name, { added, changed }] of Object.entries(SERVICE_LAYER)) {
    test(`service generator "${name}" adds and changes exactly the files the vocabulary reaches`, async () => {
      const expected = await emit(withoutRules, [catalog[name]!.factory()]);
      const actual = await emit(withRules, [catalog[name]!.factory()]);
      expect(expected["<threw>"]).toBeUndefined();
      expect(Object.keys(expected).filter((p) => !(p in actual))).toEqual([]);
      expect(Object.keys(actual).filter((p) => !(p in expected)).sort()).toEqual(added);
      expect(Object.keys(expected).filter((p) => actual[p] !== expected[p]).sort()).toEqual(changed);
    });
  }

  test("docs-site differs by exactly the new nodes in its data payload", async () => {
    const expected = await emit(withoutRules, [catalog[DOCS_SITE]!.factory()]);
    const actual = await emit(withRules, [catalog[DOCS_SITE]!.factory()]);
    expect(expected["<threw>"]).toBeUndefined();
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    const moved = Object.keys(expected).filter((p) => actual[p] !== expected[p]);
    for (const path of moved) {
      // Every line the page had is still there, in order; every added line belongs to a new node.
      const before = expected[path]!.split("\n");
      const after = actual[path]!.split("\n");
      let kept = 0;
      for (const line of after) if (line === before[kept]) kept++;
      expect({ path, kept }).toEqual({ path, kept: before.length });
    }
    const added = moved.flatMap((p) => actual[p]!.split("\n").filter((l) => !expected[p]!.split("\n").includes(l)));
    expect(added.length).toBeGreaterThan(0);
    const ids = added.filter((l) => l.includes(`"type": `)).map((l) => l.trim());
    expect([...new Set(ids)].sort()).toEqual(
      [`"type": "api",`, `"type": "binding",`, `"type": "operation",`, `"type": "transition",`],
    );
  });

  test("every generator in one run emits the same files, byte for byte (docs-site aside)", async () => {
    // shared-model needs a `files` selection `meta gen` supplies; prisma-schema refuses the
    // model's view-backed projection, with and without the vocabulary alike.
    const runnable = Object.entries(catalog)
      .filter(([n]) => n !== "shared-model" && n !== "prisma-schema" && n !== DOCS_SITE)
      .map(([, e]) => e.factory);
    const expected = await emit(withoutRules, runnable.map((f) => f()));
    const actual = await emit(withRules, runnable.map((f) => f()));
    expect(expected["<threw>"]).toBeUndefined();
    expect(Object.keys(expected).length).toBeGreaterThan(10);
    // The rules layers add their own files beside the rest, and move none of them; the service
    // layers add and change exactly the files their own tests pin. A value module
    // the contract layer writes for an operation is the entity generator's, already in both runs.
    const added = [...Object.values(RULES_LAYER).flat(), ...Object.values(SERVICE_LAYER).flatMap((l) => l.added)].filter((p) => !(p in expected));
    expect(Object.keys(actual).filter((p) => !(p in expected)).sort()).toEqual([...added].sort());
    for (const p of added) delete actual[p];
    // The service generators' changed files are pinned by their own tests above.
    for (const p of Object.values(SERVICE_LAYER).flatMap((l) => l.changed)) {
      delete actual[p];
      delete expected[p];
    }
    expect(actual).toEqual(expected);
  });

  test("migrate's expected schema is the same", () => {
    const views = (m: MetaRoot) => buildProjectionViews(m, { dialect: "postgres" });
    expect(buildExpectedSchema(withRules, { dialect: "postgres", views: views(withRules) }))
      .toEqual(buildExpectedSchema(withoutRules, { dialect: "postgres", views: views(withoutRules) }));
  });
});

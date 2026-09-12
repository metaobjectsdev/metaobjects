// FR-023 §4.3 — sharedModelFile(): the publisher's flattened shared-model artifact.
//
// A publisher project's two source files declare `acme::common::{Address, Audited,
// Customer}` exactly as the pinned cross-port corpus artifact
// (fixtures/dependency-conformance/artifacts/acme-common-v1.json) does, plus an
// INTERNAL `acme::common::Secret` entity (never published in the byte-identical
// scenarios below) and a `requirement.functional` (always excluded). Secret exists
// to exercise the closure check (a real `field.object` ref to Address) and the
// core-provider re-load check (a throwaway common attr no core provider ships) —
// see the report for why these use Secret rather than Customer (the pinned
// artifact's actual Customer/Address pair carries no ref between them at all).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { sharedModelFile } from "../src/generators/shared-model-file.js";
import {
  MetaDataLoader,
  ATTR_SUBTYPE_STRING,
  type MetaDataTypeProvider,
} from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "fixtures")) && existsSync(join(dir, "server"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("could not locate repo root (dir containing fixtures/ and server/)");
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(import.meta.dir);
const PINNED_ARTIFACT = join(REPO_ROOT, "fixtures", "dependency-conformance", "artifacts", "acme-common-v1.json");
const PINNED_HASH = "sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d";

// A throwaway provider registering ONE common attr no core provider ships —
// stands in for "a consumer-provider attr" (registerCommonAttrs, not a whole new
// subtype, per ADR-0050: common attrs project onto every type, so this is the
// simplest real vocabulary a downstream provider could add).
function secretHandlingProvider(): MetaDataTypeProvider {
  return {
    id: "test-secret-handling",
    dependencies: ["metaobjects-core-types"],
    registerTypes(registry) {
      registry.registerCommonAttrs([
        {
          name: "secretHandling",
          valueType: ATTR_SUBTYPE_STRING,
          required: false,
          description: "test-only throwaway attr — not core vocabulary.",
        },
      ]);
    },
  };
}

// File A: Address (object.value) + Audited (abstract object.entity) — exactly the
// shape of the pinned artifact's Address/Audited.
const FILE_A = {
  "metadata.root": {
    package: "acme::common",
    children: [
      {
        "object.value": {
          name: "Address",
          children: [
            { "field.string": { name: "city" } },
            { "field.string": { name: "street" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Audited",
          abstract: true,
          children: [{ "field.timestamp": { name: "createdAt" } }],
        },
      },
    ],
  },
};

// File B: Customer (exactly the pinned artifact's shape), Secret (internal — a real
// field.object ref to Address, plus the throwaway @secretHandling attr), and a
// requirement.functional (always excluded regardless of include/exclude).
const FILE_B = {
  "metadata.root": {
    package: "acme::common",
    children: [
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "email", "@maxLength": 120 } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Secret",
          "@secretHandling": "vault",
          children: [
            { "source.rdb": { "@table": "secrets" } },
            { "field.long": { name: "id" } },
            { "field.object": { name: "billingAddress", "@objectRef": "Address" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "requirement.functional": {
          name: "KeepSecretsSafe",
          "@level": 5,
          "@status": "live",
          "@statement": "Every secret's billing address is stored encrypted at rest.",
          "@counterexample": "A secret row with a plaintext billing address.",
        },
      },
    ],
  },
};

let tmp: string;
let fileA: string;
let fileB: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "shared-model-file-"));
  mkdirSync(join(tmp, "metaobjects"), { recursive: true });
  fileA = join(tmp, "metaobjects", "meta.common-base.json");
  fileB = join(tmp, "metaobjects", "meta.common-customer.json");
  writeFileSync(fileA, JSON.stringify(FILE_A, null, 2));
  writeFileSync(fileB, JSON.stringify(FILE_B, null, 2));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Loads the outer `opts.metadata` MetaRoot `runGen` requires (non-strict — the
 *  strict, provider-aware load under test is entirely INSIDE sharedModelFile()'s
 *  own standalone re-load of `ctx.sourceFiles`/`opts.files`). */
async function loadOuterRoot() {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([new FileSource(fileA), new FileSource(fileB)]);
  expect(errors).toEqual([]);
  return root;
}

async function gen(generator: ReturnType<typeof sharedModelFile>, outDir: string) {
  const metadata = await loadOuterRoot();
  return runGen({
    config: defineConfig({
      outDir,
      extStyle: "none",
      dbImport: "../db",
      dialect: "sqlite",
      generators: [generator],
      // Needed because Secret (loaded on every run — it lives in fileB, always
      // among ctx.sourceFiles) carries @secretHandling; sharedModelFile()'s own
      // standalone load is STRICT and uses `ctx.registry`, which the runner
      // composes from exactly this list (mirrors sdk's loadMemory).
      providers: [secretHandlingProvider()],
    }),
    metadata,
    projectRoot: outDir,
    sourceFiles: [fileA, fileB],
  });
}

describe("sharedModelFile()", () => {
  test("(a) emits the artifact byte-equal to the pinned corpus artifact", async () => {
    const result = await gen(
      sharedModelFile({
        name: "acme-common",
        include: ["acme::common::**"],
        exclude: ["acme::common::Secret"],
        version: "1.0.0",
      }),
      tmp,
    );
    expect(result.conflicts).toEqual([]);
    const artifactPath = join(tmp, "acme-common.metaobjects.json");
    const actual = readFileSync(artifactPath, "utf-8");
    const expected = readFileSync(PINNED_ARTIFACT, "utf-8");
    expect(actual).toBe(expected);
  });

  test("(b) the manifest matches the Global Constraints example, pinned hash included", async () => {
    await gen(
      sharedModelFile({
        name: "acme-common",
        include: ["acme::common::**"],
        exclude: ["acme::common::Secret"],
        version: "1.0.0",
      }),
      tmp,
    );
    const manifest = JSON.parse(readFileSync(join(tmp, "metaobjects.pkg.json"), "utf-8"));
    expect(manifest).toEqual({
      schema_version: 1,
      name: "acme-common",
      version: "1.0.0",
      metamodelVersion: "1.0",
      artifact: "acme-common.metaobjects.json",
      integrity: PINNED_HASH,
      packages: ["acme::common"],
      nodes: ["acme::common::Address", "acme::common::Audited", "acme::common::Customer"],
    });
  });

  test("(c) determinism — two runs produce identical bytes", async () => {
    const opts = () =>
      sharedModelFile({
        name: "acme-common",
        include: ["acme::common::**"],
        exclude: ["acme::common::Secret"],
        version: "1.0.0",
      });
    const dirA = join(tmp, "run-a");
    const dirB = join(tmp, "run-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    await gen(opts(), dirA);
    await gen(opts(), dirB);
    expect(readFileSync(join(dirA, "acme-common.metaobjects.json"), "utf-8"))
      .toBe(readFileSync(join(dirB, "acme-common.metaobjects.json"), "utf-8"));
    expect(readFileSync(join(dirA, "metaobjects.pkg.json"), "utf-8"))
      .toBe(readFileSync(join(dirB, "metaobjects.pkg.json"), "utf-8"));
  });

  // Closure: the pinned artifact's REAL Customer/Address pair carries no ref
  // between them at all (Customer's fields are id/email/pk only — confirmed by
  // reading the pinned artifact; see the report). Secret's real `field.object
  // @objectRef: Address` is the genuine edge this repo's fixtures provide, so the
  // closure failure is exercised on `Secret -> Address` instead of the brief's
  // `Customer -> Address` example. Same algorithm, same message shape.
  test("(d) closure failure — an unincluded referenced target fails naming the pair", async () => {
    await expect(
      gen(sharedModelFile({ name: "acme-common", include: ["acme::common::Secret"] }), tmp),
    ).rejects.toThrow(
      /include it or exclude the referrer:[\s\S]*acme::common::Secret → acme::common::Address/,
    );
  });

  test("(e) a files subset omitting Customer's file exports exactly two nodes", async () => {
    await gen(
      sharedModelFile({
        name: "acme-common-partial",
        include: ["acme::common::**"],
        files: [fileA],
        version: "1.0.0",
      }),
      tmp,
    );
    const manifest = JSON.parse(readFileSync(join(tmp, "metaobjects.pkg.json"), "utf-8"));
    expect(manifest.nodes).toEqual(["acme::common::Address", "acme::common::Audited"]);
  });

  // Core-provider re-load: closure passes (Address is included alongside Secret),
  // but Secret's @secretHandling attr is registered by the run's own provider
  // (needed just to LOAD it at all, strict) and not by any core provider — so the
  // re-load-with-core-providers-only step must fail it.
  test("(f) a node carrying a consumer-provider attr fails the core-only re-load", async () => {
    await expect(
      gen(
        sharedModelFile({
          name: "acme-common",
          include: ["acme::common::Secret", "acme::common::Address"],
        }),
        tmp,
      ),
    ).rejects.toThrow(
      /needs a provider this toolchain does not ship; Phase 1 exports must load with core vocabulary/,
    );
  });

  test("empty selection fails with a clear error", async () => {
    await expect(
      gen(sharedModelFile({ name: "acme-common", include: ["acme::nothing::**"] }), tmp),
    ).rejects.toThrow(/selected no nodes/);
  });

  // Review ⚠️ — effectivePackage() (docs-paths.ts) derives a node's package from ITS
  // OWN resolutionKey()/fileDefaultPackage. A nested field never carries its own
  // `package`, so its fileDefaultPackage is stamped from the FILE's root default —
  // NOT from an enclosing top-level object's own (different) explicit `package`. The
  // loader's OWN generic reference resolution (validation-registry.ts's `walk()`)
  // instead THREADS the referrer package down the tree, so a nested field resolves
  // its bare refs against the ENCLOSING TOP-LEVEL OBJECT's actual package — correctly,
  // by construction. This test drives that exact shape (file default "acme::common",
  // a top-level node explicitly overriding to "acme::other", a nested field's bare
  // ref that only resolves correctly under the override) through the closure check,
  // to find out whether `effectivePackage()`-derived referrerPkg agrees.
  test("package-override: a top-level node's own explicit package governs its nested field's bare-ref resolution in the closure check", async () => {
    const fileC = join(tmp, "metaobjects", "meta.pkg-override.json");
    writeFileSync(
      fileC,
      JSON.stringify(
        {
          "metadata.root": {
            package: "acme::common", // the FILE default
            children: [
              {
                "object.value": {
                  name: "Gadget",
                  package: "acme::other", // explicit override, DIFFERENT from the file default
                  children: [{ "field.object": { name: "part", "@objectRef": "Thing" } }],
                },
              },
              {
                "object.value": {
                  name: "Thing",
                  package: "acme::other",
                  children: [{ "field.string": { name: "label" } }],
                },
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const loader = new MetaDataLoader();
    const { root: metadata, errors } = await loader.load([new FileSource(fileC)]);
    expect(errors).toEqual([]);

    // include ONLY Gadget: a CORRECTLY package-scoped bare ref resolves "Thing" to
    // acme::other::Thing (Gadget's own package), which is excluded here — closure
    // must fail naming that pair. Were the referrer package wrongly computed as the
    // file default "acme::common", the bare ref would resolve to NOTHING (no
    // acme::common::Thing exists), and `checkClosure`'s defensive
    // `if (resolved === undefined) continue` (written to trust the loader already
    // validated every ref) would silently skip it instead — no error at all.
    await expect(
      runGen({
        config: defineConfig({
          outDir: tmp,
          extStyle: "none",
          dbImport: "../db",
          dialect: "sqlite",
          generators: [sharedModelFile({ name: "pkg-override", include: ["acme::other::Gadget"] })],
        }),
        metadata,
        projectRoot: tmp,
        sourceFiles: [fileC],
      }),
    ).rejects.toThrow(/acme::other::Gadget.*acme::other::Thing/s);
  });
});

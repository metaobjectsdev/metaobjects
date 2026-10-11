/**
 * An OWNED shared-model generator still publishes an artifact a consumer's `meta deps sync`
 * verifies — end to end, through the BUILT CLI (ADR-0034 Amendment 7).
 *
 * `shared-model` was the one generator ruled package-only for a reason of substance: its
 * output is not a helper, it is a contract. A consumer hashes the artifact, checks the hash
 * against the manifest, and loads the document with its own vocabulary. So it was made
 * ejectable the way `cube-model` is split: the copy an adopter owns decides which source
 * files may contribute and which version is published, and everything a consumer checks
 * stays in the package (`buildSharedModel`, `renderSharedModelFiles`).
 *
 * The byte-identity gate in codegen-ts proves the copy writes the same two files. This file
 * proves the claim that matters to the OTHER project: published by an ejected copy, the
 * artifact is the one the dependency corpus pins, and a real consumer syncs it, locks it and
 * passes `meta verify --deps` against it. Then the gate is shown to convict: an artifact
 * changed after it was published is refused, so the green run above was a real check.
 *
 * Subprocess-per-command for the reason `verify-codegen-ejected-generator` gives: the
 * config is re-read under a fresh name each load but the modules it imports are cached.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256Integrity } from "@metaobjectsdev/sdk";
import { meta, requireFreshDist } from "./support/built-cli.js";

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");
// Inside the workspace, so an ejected template's `@metaobjectsdev/codegen-ts` import
// resolves by walking up to the workspace root.
const WORKSPACE_TMP = join(FIXTURES, "__tmp__");

const DEP_NAME = "acme-common";
const ARTIFACT = `${DEP_NAME}.metaobjects.json`;
const MANIFEST = "metaobjects.pkg.json";
const PUBLISHED = "published";

// The artifact every port's dependency corpus pins for this model
// (fixtures/dependency-conformance/README.md), read as raw bytes.
const PINNED_ARTIFACT = readFileSync(
  resolve(import.meta.dirname, "../../../../../../fixtures/dependency-conformance/artifacts/acme-common-v1.json"),
);

/** The publisher's model: the three nodes of the pinned artifact, over two files. */
const PUBLISHER_BASE = {
  "metadata.root": {
    package: "acme::common",
    children: [
      {
        "object.value": {
          name: "Address",
          children: [{ "field.string": { name: "city" } }, { "field.string": { name: "street" } }],
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
const PUBLISHER_CUSTOMER = {
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
    ],
  },
};

/** The consumer's own model, so the post-sync load has something of its own to combine. */
const CONSUMER_APP = {
  "metadata.root": {
    package: "app",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
};

function publisherConfig(importFrom: string): string {
  return [
    `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
    `import { sharedModelFile } from ${JSON.stringify(importFrom)};`,
    `export default defineConfig({`,
    `  outDir: ${JSON.stringify(PUBLISHED)},`,
    `  dialect: "sqlite",`,
    `  generators: [sharedModelFile({ name: ${JSON.stringify(DEP_NAME)}, include: ["acme::common::**"], version: "1.0.0" })],`,
    `});`,
  ].join("\n");
}

const PACKAGED = publisherConfig("@metaobjectsdev/codegen-ts/generators");
const OWNED = publisherConfig("./codegen/generators/shared-model.js");

/** A publisher and a consumer, siblings under one root, the consumer depending on what
 *  the publisher's `meta gen` writes. */
function setupProjects(): { root: string; publisher: string; consumer: string } {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "shared-model-"));

  const publisher = join(root, "publisher");
  mkdirSync(join(publisher, "metaobjects"), { recursive: true });
  writeFileSync(join(publisher, "metaobjects", "meta.common-base.json"), JSON.stringify(PUBLISHER_BASE, null, 2));
  writeFileSync(join(publisher, "metaobjects", "meta.common-customer.json"), JSON.stringify(PUBLISHER_CUSTOMER, null, 2));
  writeFileSync(join(publisher, "metaobjects.config.ts"), PACKAGED);

  const consumer = join(root, "consumer");
  mkdirSync(join(consumer, "metaobjects"), { recursive: true });
  writeFileSync(join(consumer, "metaobjects", "meta.app.json"), JSON.stringify(CONSUMER_APP));
  mkdirSync(join(consumer, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(consumer, ".metaobjects", "config.json"),
    JSON.stringify({
      schema_version: 1,
      sources: [],
      dependencies: [{ name: DEP_NAME, path: `../publisher/${PUBLISHED}` }],
    }),
  );
  return { root, publisher, consumer };
}

function published(publisher: string): { artifact: Buffer; manifest: string } {
  return {
    artifact: readFileSync(join(publisher, PUBLISHED, ARTIFACT)),
    manifest: readFileSync(join(publisher, PUBLISHED, MANIFEST), "utf8"),
  };
}

// Precondition once per FILE, not per test: this gate runs the BUILT CLI.
beforeAll(requireFreshDist);

describe("shared-model — published by an owned copy, verified by a consumer", () => {
  test("an ejected copy publishes the pinned artifact, and `meta deps sync` locks and verifies it", async () => {
    const { root, publisher, consumer } = setupProjects();
    try {
      // As shipped, first: what the package's generator publishes.
      expect(await meta(publisher, "gen")).toMatchObject({ exit: 0 });
      const packaged = published(publisher);
      expect(packaged.artifact.equals(PINNED_ARTIFACT)).toBe(true);

      // Take ownership, changing nothing, and wire the copy as `meta eject` prints.
      const eject = await meta(publisher, "eject", "shared-model", "--format", "text");
      expect(eject).toMatchObject({ exit: 0 });
      expect(eject.output).toContain('import { sharedModelFile } from "./codegen/generators/shared-model.js";');
      // The entry names the options the factory cannot be called without.
      expect(eject.output).toContain("If sharedModelFile({ name, include }) is not in `generators` yet");
      writeFileSync(join(publisher, "metaobjects.config.ts"), OWNED);

      // The committed artifact was written by the PACKAGE's generator. The codegen drift
      // gate runs the owned copy and finds nothing to change.
      expect(await meta(publisher, "verify", "--codegen")).toMatchObject({ exit: 0 });

      // Published from scratch by the owned copy: the same two files, to the byte.
      rmSync(join(publisher, PUBLISHED), { recursive: true, force: true });
      rmSync(join(publisher, ".metaobjects"), { recursive: true, force: true });
      expect(await meta(publisher, "gen")).toMatchObject({ exit: 0 });
      const owned = published(publisher);
      expect(owned.artifact.equals(PINNED_ARTIFACT)).toBe(true);
      expect(owned.manifest).toBe(packaged.manifest);
      // The manifest's hash is the hash of the bytes beside it, in the format sdk verifies.
      expect((JSON.parse(owned.manifest) as { integrity: string }).integrity).toBe(sha256Integrity(owned.artifact));

      // The consumer's side of the contract, against what the owned copy published.
      const sync = await meta(consumer, "deps", "sync");
      expect(sync).toMatchObject({ exit: 0 });
      const snapshot = join(consumer, ".metaobjects", "deps", DEP_NAME, ARTIFACT);
      expect(readFileSync(snapshot).equals(PINNED_ARTIFACT)).toBe(true);
      const lock = JSON.parse(readFileSync(join(consumer, ".metaobjects", "deps.lock.json"), "utf8")) as {
        dependencies: Record<string, { version: string; integrity: string; nodes: string[] }>;
      };
      expect(lock.dependencies[DEP_NAME]).toMatchObject({
        version: "1.0.0",
        integrity: sha256Integrity(PINNED_ARTIFACT),
        nodes: ["acme::common::Address", "acme::common::Audited", "acme::common::Customer"],
      });
      expect(await meta(consumer, "deps", "check")).toMatchObject({ exit: 0 });
      expect(await meta(consumer, "verify", "--deps")).toMatchObject({ exit: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);

  test("the consumer's check is real: an artifact changed after it was published is refused", async () => {
    const { root, publisher, consumer } = setupProjects();
    try {
      expect(await meta(publisher, "eject", "shared-model")).toMatchObject({ exit: 0 });
      writeFileSync(join(publisher, "metaobjects.config.ts"), OWNED);
      expect(await meta(publisher, "gen")).toMatchObject({ exit: 0 });

      // What an owned copy that wrote its own bytes after hashing would produce: a document
      // that no longer matches the manifest beside it.
      const artifact = join(publisher, PUBLISHED, ARTIFACT);
      writeFileSync(artifact, readFileSync(artifact, "utf8").replace('"city"', '"town"'));

      const sync = await meta(consumer, "deps", "sync");
      expect(sync.exit).not.toBe(0);
      expect(sync.output).toContain("but the manifest records");
      expect(existsSync(join(consumer, ".metaobjects", "deps.lock.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  // `meta verify --codegen` could not run this generator at all, packaged or owned: it
  // regenerated without the project's source files ("no source files to load") and read
  // the version default from the temp tree it writes into. Both are what `meta gen` gives
  // the generator, so the gate now gives them too.
  test("the codegen drift gate runs the packaged generator as `meta gen` does: the project's files and its package.json version", async () => {
    const { root, publisher } = setupProjects();
    try {
      // No `version` option: the default is the nearest package.json, which is the project's.
      writeFileSync(join(publisher, "metaobjects.config.ts"), PACKAGED.replace(', version: "1.0.0"', ""));
      writeFileSync(join(publisher, "package.json"), JSON.stringify({ name: "publisher", version: "2.0.0" }));
      expect(await meta(publisher, "gen")).toMatchObject({ exit: 0 });
      expect((JSON.parse(published(publisher).manifest) as { version: string }).version).toBe("2.0.0");

      expect(await meta(publisher, "verify", "--codegen")).toMatchObject({ exit: 0 });

      // And it convicts: the model moved, the published artifact did not.
      const customer = join(publisher, "metaobjects", "meta.common-customer.json");
      writeFileSync(customer, readFileSync(customer, "utf8").replace('"@maxLength": 120', '"@maxLength": 200'));
      const stale = await meta(publisher, "verify", "--codegen");
      expect(stale.exit).toBe(1);
      expect(stale.output).toContain(ARTIFACT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  test("what the copy owns is honoured: its version source, without touching what a consumer checks", async () => {
    const { root, publisher, consumer } = setupProjects();
    try {
      expect(await meta(publisher, "eject", "shared-model")).toMatchObject({ exit: 0 });
      // No `version` option, and the copy's own lookup replaced: this project publishes
      // the version it keeps in a file of its own rather than in a package.json.
      writeFileSync(
        join(publisher, "metaobjects.config.ts"),
        OWNED.replace(', version: "1.0.0"', ""),
      );
      writeFileSync(join(publisher, "VERSION"), "7.8.9\n");
      const copy = join(publisher, "codegen", "generators", "shared-model.ts");
      const source = readFileSync(copy, "utf8");
      const lookup = "const version = opts.version ?? nearestPackageVersion(ctx.inputRoot ?? ctx.projectRoot ?? process.cwd());";
      expect(source).toContain(lookup);
      writeFileSync(
        copy,
        source.replace(
          lookup,
          'const version = opts.version ?? readFileSync(join(ctx.inputRoot ?? ctx.projectRoot ?? process.cwd(), "VERSION"), "utf-8").trim();',
        ),
      );

      expect(await meta(publisher, "gen")).toMatchObject({ exit: 0 });
      const owned = published(publisher);
      expect((JSON.parse(owned.manifest) as { version: string }).version).toBe("7.8.9");
      // The artifact is the pinned one still: the version is the manifest's, not the document's.
      expect(owned.artifact.equals(PINNED_ARTIFACT)).toBe(true);

      // The drift gate regenerates in a temp tree, and `ctx.inputRoot` is still the PROJECT,
      // so the copy's own `VERSION` lookup resolves there too: clean now, and convicted when
      // the file moves on.
      expect(await meta(publisher, "verify", "--codegen")).toMatchObject({ exit: 0 });

      expect(await meta(consumer, "deps", "sync")).toMatchObject({ exit: 0 });
      expect(await meta(consumer, "verify", "--deps")).toMatchObject({ exit: 0 });
      const lock = JSON.parse(readFileSync(join(consumer, ".metaobjects", "deps.lock.json"), "utf8")) as {
        dependencies: Record<string, { version: string }>;
      };
      expect(lock.dependencies[DEP_NAME]?.version).toBe("7.8.9");

      writeFileSync(join(publisher, "VERSION"), "7.9.0\n");
      const stale = await meta(publisher, "verify", "--codegen");
      expect(stale.exit).toBe(1);
      expect(stale.output).toContain(MANIFEST);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});

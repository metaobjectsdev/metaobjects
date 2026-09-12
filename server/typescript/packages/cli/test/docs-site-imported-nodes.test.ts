// FR-023 — `meta docs --site` must resolve against the SAME loaded tree a
// consumer's own metadata resolves against, including a dependency's
// snapshot. `generateSite` (docs-site) runs an INDEPENDENT `loadModel` over
// `sourceDirs` — it does not reuse the already-loaded `collection` root — and
// `collection.sourceRoots` (sdk/src/collection.ts) deliberately EXCLUDES
// dependency artifacts ("a dependency's artifact is not a source root").
// Passing only `sourceRoots` into `generateSite` means a consumer that
// `extends` an imported abstract (entities.md § extends) or `overlay: true`s
// an imported node (abstracts-and-inheritance.md § the same rule across a
// repository boundary) — the two constructs those very docs recommend — hits
// `ERR_UNRESOLVED_SUPER` / `ERR_OVERLAY_NO_TARGET` and `--site` exits 1.
//
// The scaffold mirrors gen-imported-nodes.test.ts: a consumer package `app`
// depends on `acme-common`, a synced snapshot exporting an abstract
// `acme::common::BaseEntity` and a concrete `acme::common::Customer`.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { METAMODEL_VERSION } from "@metaobjectsdev/metadata";
import { sha256Integrity } from "@metaobjectsdev/sdk";
import { docsCommand } from "../src/commands/docs.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");

const DEP_NAME = "acme-common";
const ARTIFACT_BASENAME = "acme-common.metaobjects.json";

/** The dependency's synced snapshot: one abstract base, one concrete entity. */
const ARTIFACT = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "object.entity": {
          name: "BaseEntity",
          package: "acme::common",
          abstract: true,
          children: [{ "field.long": { name: "id" } }],
        },
      },
      {
        "object.entity": {
          name: "Customer",
          package: "acme::common",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "email" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

/** App's own entity `extends` the imported abstract `BaseEntity` — exactly the
 *  cross-repository-boundary shape entities.md's "extends: for shared abstract
 *  bases" section recommends. */
const APP_EXTENDS = JSON.stringify({
  "metadata.root": {
    package: "app",
    children: [
      {
        "object.entity": {
          name: "Author",
          extends: "acme::common::BaseEntity",
          children: [
            { "source.rdb": { "@table": "authors" } },
            { "field.string": { name: "name" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

/** App's own file amends the imported `Customer` via `overlay: true` — the
 *  other construct abstracts-and-inheritance.md recommends across a
 *  dependency boundary. */
const APP_OVERLAY = JSON.stringify({
  "metadata.root": {
    package: "acme::common",
    children: [
      {
        "object.entity": {
          name: "Customer",
          overlay: true,
          children: [{ "field.string": { name: "notes" } }],
        },
      },
    ],
  },
});

function setupRepo(appFile: string): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-docs-site-imported-"));

  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeAppFile(root, appFile);

  const depDir = join(root, ".metaobjects", "deps", DEP_NAME);
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, ARTIFACT_BASENAME), ARTIFACT, "utf8");

  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(root, ".metaobjects", "config.json"),
    JSON.stringify({
      schema_version: 1,
      sources: [],
      dependencies: [{ name: DEP_NAME, path: "../acme-common/metaobjects" }],
    }),
    "utf8",
  );

  writeFileSync(
    join(root, ".metaobjects", "deps.lock.json"),
    JSON.stringify({
      schema_version: 1,
      dependencies: {
        [DEP_NAME]: {
          version: "1.0.0",
          metamodelVersion: METAMODEL_VERSION,
          resolvedFrom: { path: "../acme-common/metaobjects" },
          artifact: ARTIFACT_BASENAME,
          integrity: sha256Integrity(ARTIFACT),
          packages: ["acme::common"],
          nodes: ["acme::common::BaseEntity", "acme::common::Customer"],
        },
      },
    }),
    "utf8",
  );

  return root;
}

function writeAppFile(root: string, contents: string): void {
  writeFileSync(join(root, "metaobjects", "meta.app.json"), contents, "utf8");
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("meta docs --site — resolves against a dependency's snapshot (FR-023)", () => {
  test("a consumer entity that `extends` an imported abstract renders instead of failing", async () => {
    const root = setupRepo(APP_EXTENDS);
    dirs.push(root);
    const out = join(root, "out-site");

    const code = await docsCommand([root, "--site", "--out", out], root);
    expect(code).toBe(0);
    expect(existsSync(join(out, "site", "index.html"))).toBe(true);
  });

  test("a consumer file that `overlay: true`s an imported node renders instead of failing", async () => {
    const root = setupRepo(APP_OVERLAY);
    dirs.push(root);
    const out = join(root, "out-site");

    const code = await docsCommand([root, "--site", "--out", out], root);
    expect(code).toBe(0);
    expect(existsSync(join(out, "site", "index.html"))).toBe(true);
  });
});

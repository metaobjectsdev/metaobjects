// FR-023 §11.1 item 2 — codegen selection honours the default exclusion of
// imported metadata: a node loaded from a dependency's synced snapshot is
// load-only unless the consumer's OWN `scope.include` names its package
// literally. `meta gen`'s output already narrows via `genCollection.inScope`
// (Task 8); this gate covers what selection alone does not — a positional
// naming an excluded import must REFUSE (exit 2) rather than silently
// generate nothing or silently generate the import.
//
// The scaffold: a consumer package `app` (declares `Order`) depends on
// `acme-common` (a synced snapshot exporting `acme::common::Address` and
// `acme::common::Customer`) — the same fixture shape the shared
// dependency-conformance corpus (fixtures/dependency-conformance/) uses for
// "a-dependency-adds-its-artifact-to-the-resolved-set".
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { METAMODEL_VERSION } from "@metaobjectsdev/metadata";
import { sha256Integrity } from "@metaobjectsdev/sdk";
import { run } from "../src/index.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");

const DEP_NAME = "acme-common";
const ARTIFACT_BASENAME = "acme-common.metaobjects.json";

/** The dependency's synced snapshot: one value object, one entity. */
const ARTIFACT = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "object.value": {
          name: "Address",
          package: "acme::common",
          children: [{ "field.string": { name: "city" } }],
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

const APP = JSON.stringify({
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
});

function genOutDir(root: string): string {
  return join(root, "generated", "db");
}

/** Scaffold a consumer of `acme-common`, optionally declaring `scope.include`. */
function setupRepo(opts: { scopeInclude?: string[] } = {}): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-imported-"));

  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), APP, "utf8");

  const depDir = join(root, ".metaobjects", "deps", DEP_NAME);
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, ARTIFACT_BASENAME), ARTIFACT, "utf8");

  const config: Record<string, unknown> = {
    schema_version: 1,
    sources: [],
    dependencies: [{ name: DEP_NAME, path: "../acme-common/metaobjects" }],
  };
  if (opts.scopeInclude) {
    config.scope = { include: opts.scopeInclude };
  }
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify(config), "utf8");

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
          nodes: ["acme::common::Address", "acme::common::Customer"],
        },
      },
    }),
    "utf8",
  );

  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(genOutDir(root))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: ["entity"],
});
`,
  );
  return root;
}

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta gen — imported nodes are excluded by default (FR-023)", () => {
  test("(a) an unscoped consumer generates its own entity, never the import", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const files = readdirSync(genOutDir(root));
      expect(files).toContain("Order.ts");
      expect(files).not.toContain("Customer.ts");
      expect(files).not.toContain("Address.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(b) scope.include naming the dependency's package generates it too", async () => {
    const root = setupRepo({ scopeInclude: ["app::**", "acme::common::**"] });
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const files = readdirSync(genOutDir(root));
      expect(files).toContain("Customer.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(c) naming an excluded import positionally refuses with exit 2", async () => {
    const root = setupRepo();
    try {
      const exit = await run(["gen", "Customer", "--cwd", root]);
      expect(exit).toBe(2);
      const all = err.join("\n");
      expect(all).toContain("imported from dependency 'acme-common'");
      expect(all).toContain("scope.include");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(d) verify --codegen is green afterward and reports no drift for the absent import", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      out = [];
      err = [];
      const exit = await run(["verify", "--cwd", root, "--codegen"]);
      const all = [...out, ...err].join("\n");
      expect(exit).toBe(0);
      expect(all).not.toContain("Customer.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// FR-023 §11 — the requirements ledger must not count imported entities the
// project does not own.
//
// The object-coverage pass (`coverableEntities` in `requirement-check.ts`)
// demands a capability claim for every non-abstract entity in the loaded
// model. A dependency's synced snapshot loads its entities so the consumer's
// OWN model can resolve against them (`extends`, relationships) — but the
// publisher owns those entities, and the consumer never declared them. Left
// unfiltered, adding a dependency makes every one of its entities count
// against THIS project's ledger, reporting a consumer as failing to claim
// things it does not own.
//
// The fix narrows the denominator with `Collection.inScope` — the same
// default-exclusion-of-imports predicate `meta gen` and `meta migrate`
// already use — so an import counts only when the consumer's own
// `scope.include` names its package literally.
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METAMODEL_VERSION } from "@metaobjectsdev/metadata";
import { sha256Integrity } from "@metaobjectsdev/sdk";
import { run } from "../src/index.js";

const DEP_NAME = "acme-common";
const ARTIFACT_BASENAME = "acme-common.metaobjects.json";

/** The dependency's synced snapshot — one entity the publisher owns. */
const SNAP = JSON.stringify({
  "metadata.root": {
    children: [
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

/** The consumer's own model: one entity it owns and claims. */
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

/** One requirement claiming the consumer's own entity by FQN. */
const REQUIREMENTS = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "requirement.functional": {
          name: "orderRecord",
          "@level": 4,
          "@status": "live",
          "@statement": "An order is a durable record.",
          "@counterexample": "An order vanishes on restart.",
          "@implementedBy": ["app::Order"],
        },
      },
    ],
  },
});

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A consumer of `acme-common`, optionally declaring `scope.include`. */
function project(opts: { scopeInclude?: string[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "vreq-imported-"));
  dirs.push(root);

  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), APP, "utf8");
  writeFileSync(join(root, "metaobjects", "meta.req.json"), REQUIREMENTS, "utf8");

  const depDir = join(root, ".metaobjects", "deps", DEP_NAME);
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, ARTIFACT_BASENAME), SNAP, "utf8");

  const config: Record<string, unknown> = {
    schema_version: 1,
    sources: [],
    dependencies: [{ name: DEP_NAME, path: "../acme-common/metaobjects" }],
  };
  if (opts.scopeInclude) config.scope = { include: opts.scopeInclude };
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
          integrity: sha256Integrity(SNAP),
          packages: ["acme::common"],
          nodes: ["acme::common::Customer"],
        },
      },
    }),
    "utf8",
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

describe("meta verify — the requirements ledger excludes out-of-scope imports (FR-023)", () => {
  test("an unscoped consumer's ledger counts only its own entity — the import is invisible", async () => {
    const root = project();
    const exit = await run(["verify", "--format", "text", "--cwd", root]);
    expect(exit).toBe(0);

    const all = [...out, ...err].join("\n");
    // The denominator is 1 (Order only) and it is fully claimed — Customer, an
    // import this project never opted into owning, does not enter the count.
    expect(all).toContain("1/1 entities claimed");
    // And it is never named as an unclaimed entity, even though nothing here
    // claims it either — it is not COVERABLE, so it is not counted at all.
    expect(all).not.toContain("WARN_REQUIREMENT_OBJECT_UNCLAIMED");
    expect(all).not.toContain("acme::common::Customer");
    // The dependency count on the summary line is unaffected by this change —
    // it still reports the one declared dependency.
    expect(all).toContain(", 1 from dependencies.");
  });

  test("naming the dependency's package in scope.include makes its entity coverable — and unclaimed", async () => {
    const root = project({ scopeInclude: ["app::**", "acme::common::**"] });
    const exit = await run(["verify", "--format", "text", "--cwd", root]);
    // Coverage is advisory (WARN), so an unclaimed import still exits 0 —
    // exactly as an unclaimed entity of the consumer's own always has.
    expect(exit).toBe(0);

    const all = [...out, ...err].join("\n");
    expect(all).toContain("1/2 entities claimed");
    expect(all).toContain("WARN_REQUIREMENT_OBJECT_UNCLAIMED");
    expect(all).toContain("acme::common::Customer");
    expect(all).toContain(", 1 from dependencies.");
  });
});

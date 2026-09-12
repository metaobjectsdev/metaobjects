// FR-023 §11.1 item 2 (2026-09-11 qualification) — `Collection.inScope` is
// `matchesScope(fqn, scope) && (...)`, so declaring `scope.include` narrows
// the requirements ledger's denominator even for a project with ZERO
// dependencies — a real behaviour change the CHANGELOG records ("A project
// that declares scope.include now sees its requirements-ledger denominator
// narrow to that scope — even with zero dependencies"), and nothing exercised
// it: `verify-requirements-imported.test.ts` only covers the WITH-a-
// dependency case (the import-exclusion half of the predicate); this covers
// the other half — `matchesScope` alone, no dependency involved at all.
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

/** Two of the project's OWN entities, in different packages — no dependency
 *  anywhere in this fixture. */
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

const OTHER = JSON.stringify({
  "metadata.root": {
    package: "other",
    children: [
      {
        "object.entity": {
          name: "Thing",
          children: [
            { "source.rdb": { "@table": "things" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

/** One requirement claiming only `app::Order`. */
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

/** A project with NO dependencies, optionally declaring `scope.include`. */
function project(opts: { scopeInclude?: string[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "vreq-scope-nodeps-"));
  dirs.push(root);

  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), APP, "utf8");
  writeFileSync(join(root, "metaobjects", "meta.other.json"), OTHER, "utf8");
  writeFileSync(join(root, "metaobjects", "meta.req.json"), REQUIREMENTS, "utf8");

  const config: Record<string, unknown> = { schema_version: 1, sources: [] };
  if (opts.scopeInclude) config.scope = { include: opts.scopeInclude };
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify(config), "utf8");

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

describe("meta verify — scope.include narrows the ledger denominator with ZERO dependencies (FR-023)", () => {
  test("no scope declared: both entities are coverable, only one is claimed", async () => {
    const root = project();
    const exit = await run(["verify", "--format", "text", "--cwd", root]);
    expect(exit).toBe(0);

    const all = [...out, ...err].join("\n");
    expect(all).toContain("1/2 entities claimed");
    expect(all).toContain("other::Thing");
  });

  test("scope.include naming only app:: narrows the denominator to 1/1 — other::Thing drops out entirely", async () => {
    const root = project({ scopeInclude: ["app::**"] });
    const exit = await run(["verify", "--format", "text", "--cwd", root]);
    expect(exit).toBe(0);

    const all = [...out, ...err].join("\n");
    // Denominator narrows to the declared scope alone — other::Thing is
    // excluded from the COUNT, not merely reported as unclaimed.
    expect(all).toContain("1/1 entities claimed");
    expect(all).not.toContain("other::Thing");
    expect(all).not.toContain("WARN_REQUIREMENT_OBJECT_UNCLAIMED");
  });
});

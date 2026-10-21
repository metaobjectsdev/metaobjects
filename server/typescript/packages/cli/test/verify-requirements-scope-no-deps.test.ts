// Requirement coverage and `scope.include` (1.1.0 release review): coverage
// counts every non-abstract project entity except one imported from a
// dependency, and `scope` filters generated output only — it does not narrow
// the ledger's denominator. FR-023 §11.1 item 2 once narrowed it by scope even
// with zero dependencies; this pins the ruling that it does not, the half of
// the predicate `verify-requirements-imported.test.ts` (the dependency-import
// exclusion) does not reach.
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

describe("meta verify — scope.include does not narrow the ledger denominator (scope is an output filter)", () => {
  test("no scope declared: both entities are coverable, only one is claimed", async () => {
    const root = project();
    const exit = await run(["verify", "--format", "text", "--cwd", root]);
    expect(exit).toBe(0);

    const all = [...out, ...err].join("\n");
    expect(all).toContain("1/2 entities claimed");
    expect(all).toContain("other::Thing");
  });

  test("scope.include does NOT narrow coverage: scope is an output filter, only the dependency-import rule applies", async () => {
    const root = project({ scopeInclude: ["app::**"] });
    const exit = await run(["verify", "--format", "text", "--cwd", root]);
    expect(exit).toBe(0);

    const all = [...out, ...err].join("\n");
    // Coverage counts every own entity regardless of the project's `scope`
    // patterns (T18 ruling, matches the Python port).
    expect(all).toContain("1/2 entities claimed");
    expect(all).toContain("other::Thing");
  });
});

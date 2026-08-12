// `meta verify` + requirements — the EXIT CODE contract, end to end.
//
// The unit tests in test/unit/requirement-check.test.ts assert what
// `checkRequirements()` returns. They cannot tell you what `meta verify` DOES with
// it: whether a diagnostic reaches the exit code, whether a warning stays a warning,
// or whether the loader refuses the file before verify runs at all. Those are the
// things an adopter's CI actually depends on, and until this file existed they were
// only ever checked by hand.
//
// Each case drives the real command dispatcher, so a regression in the wiring —
// requirements silently unhooked from the exit-code max, say — fails here.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

// verify lazily imports its (heavy) command module on first dispatch; a cold runner
// can exceed bun's default 5s. Generous timeout, still fails loudly on a real hang.
const TIMEOUT_MS = 30_000;

const ENTITIES = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.uuid": { name: "id" } },
            { "field.string": { name: "reference" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

/** A project with the given requirements file (raw JSON string). */
function project(requirements: string, extra?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vreq-"));
  mkdirSync(join(dir, "metaobjects"), { recursive: true });
  writeFileSync(join(dir, "metaobjects", "meta.shop.json"), ENTITIES);
  writeFileSync(join(dir, "metaobjects", "meta.requirements.json"), requirements);
  for (const [rel, body] of Object.entries(extra ?? {})) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const req = (fields: Record<string, unknown>, subType = "functional") =>
  JSON.stringify({
    "metadata.root": { package: "acme::shop", children: [{ [`requirement.${subType}`]: fields }] },
  });

const L4 = {
  name: "orderRecord",
  "@level": 4,
  "@status": "live",
  "@statement": "An order is a durable record.",
  "@violation": "An order vanishes on restart.",
};

describe("meta verify — requirements exit-code contract", () => {
  test("a clean requirement tree exits 0", async () => {
    const dir = project(req({ ...L4, "@implementedBy": ["Order"] }));
    expect(await run(["verify", "--cwd", dir])).toBe(0);
  }, TIMEOUT_MS);

  test("a model with NO requirements exits 0 — opt-in by declaration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vreq-"));
    mkdirSync(join(dir, "metaobjects"), { recursive: true });
    writeFileSync(join(dir, "metaobjects", "meta.shop.json"), ENTITIES);
    expect(await run(["verify", "--cwd", dir])).toBe(0);
  }, TIMEOUT_MS);

  test("a dangling @implementedBy on status=live exits 1", async () => {
    const dir = project(req({ ...L4, "@implementedBy": ["Ordur"] }));
    expect(await run(["verify", "--cwd", dir])).toBe(1);
  }, TIMEOUT_MS);

  // The asymmetry that forced the loader/verify split: the SAME unresolved reference
  // is an error on live and expected on abandoned, because those nodes are meant to
  // be gone. If this ever goes red, the mechanism's whole point has regressed.
  test("the SAME dangling reference on status=abandoned exits 0", async () => {
    const dir = project(req({ ...L4, "@status": "abandoned", "@implementedBy": ["Ordur"] }));
    expect(await run(["verify", "--cwd", dir])).toBe(0);
  }, TIMEOUT_MS);

  test("@implementedBy above the L4 link floor exits 1", async () => {
    const dir = project(req({ ...L4, "@level": 2, "@implementedBy": ["Order"] }));
    expect(await run(["verify", "--cwd", dir])).toBe(1);
  }, TIMEOUT_MS);

  // Refused by the LOADER, before verify runs — the difference between registered
  // vocabulary and a hand-parsed side file.
  test("a typo'd @status exits 1 (loader refuses the load)", async () => {
    const dir = project(req({ ...L4, "@status": "abandonned", "@implementedBy": ["Order"] }));
    expect(await run(["verify", "--cwd", dir])).toBe(1);
  }, TIMEOUT_MS);

  test("a live architectural requirement claimed by nothing exits 1", async () => {
    const dir = project(
      req(
        {
          name: "uuidPks",
          "@status": "live",
          "@statement": "Every entity has a uuid primary key.",
          "@violation": "An entity keyed by a composite string.",
        },
        "architectural",
      ),
    );
    expect(await run(["verify", "--cwd", dir])).toBe(1);
  }, TIMEOUT_MS);

  // Coverage is advisory: an unclaimed entity WARNS and must not fail the build.
  // If this flips to 1, OBJECT_COVERAGE_SEVERITY was promoted without the
  // completeness precondition its comment requires.
  test("an unclaimed entity WARNS but still exits 0", async () => {
    const dir = project(
      req({ ...L4, name: "unrelated", "@implementedBy": [] }),
    );
    expect(await run(["verify", "--cwd", dir])).toBe(0);
  }, TIMEOUT_MS);

  test("@verifiedBy naming a test that exists nowhere exits 1", async () => {
    const dir = project(
      req({ ...L4, "@implementedBy": ["Order"], "@verifiedBy": ["OrderServiceTest"] }),
      { "test/other.test.ts": "test('something else', () => {});" },
    );
    expect(await run(["verify", "--cwd", dir])).toBe(1);
  }, TIMEOUT_MS);

  test("@verifiedBy naming a test that exists exits 0", async () => {
    const dir = project(
      req({ ...L4, "@implementedBy": ["Order"], "@verifiedBy": ["OrderServiceTest"] }),
      { "test/order.test.ts": "test('OrderServiceTest', () => {});" },
    );
    expect(await run(["verify", "--cwd", dir])).toBe(0);
  }, TIMEOUT_MS);
});

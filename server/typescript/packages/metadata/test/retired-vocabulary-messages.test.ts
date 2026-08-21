// #337 end-to-end: what an adopter ACTUALLY sees when their ledger stops loading.
//
// The unit tests prove the map answers correctly. These prove the answer reaches the human
// — through the real loader, at each of the three doors retired vocabulary can fail at.
// Testing the map alone would have passed while every message stayed generic.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

async function loadErrors(model: unknown): Promise<string> {
  const r = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(model)),
  ]);
  return r.errors.map((e) => e.message).join("\n");
}

const requirement = (extra: Record<string, unknown>) => ({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "requirement.functional": {
          name: "orderRecord",
          "@level": 4,
          "@status": "live",
          "@statement": "An order records what was bought.",
          "@violation": "An order that cannot say what was bought.",
          ...extra,
        },
      },
    ],
  },
});

describe("#337 — a retired attribute explains itself", () => {
  test("@verifiedBy names the release and the migration guide", async () => {
    const msg = await loadErrors(requirement({ "@verifiedBy": ["OrderServiceTest"] }));
    expect(msg).toContain("@verifiedBy");
    expect(msg).toContain("retired in 0.24.0");
    expect(msg).toContain("docs/features/migrations/verified-by-retirement.md");
  });

  test("it no longer claims the attribute was merely undeclared", async () => {
    // The exact phrasing that sent the reporter to file a registration bug.
    const msg = await loadErrors(requirement({ "@verifiedBy": ["X"] }));
    expect(msg).not.toContain("not declared by any registered provider");
  });

  test("@supersededBy is covered too — both halves of the FR-038 retirement", async () => {
    const msg = await loadErrors(requirement({ "@supersededBy": "OrderRecordV2" }));
    expect(msg).toContain("retired in 0.24.0");
  });

  // The load must still FAIL. A friendlier message that also started accepting the
  // attribute would silently undo an adjudicated breaking change.
  test("the load still fails — this is a message change, not a shim", async () => {
    const r = await new MetaDataLoader({ strict: true }).load([
      new InMemoryStringSource(JSON.stringify(requirement({ "@verifiedBy": ["X"] }))),
    ]);
    expect(r.errors.length).toBeGreaterThan(0);
    // Read `code` structurally rather than via `instanceof ParseError`: this test imports
    // through the package barrel, and two physical copies of the package in one process
    // give the class object and the instance different identities — the silent
    // cross-package instanceof failure this repo has been bitten by before.
    expect((r.errors[0] as { code?: string }).code).toBe("ERR_UNKNOWN_ATTR");
  });
});

describe("#337 — a retired ENUM VALUE explains itself", () => {
  test("@status: abandoned says it was retired and why deleting is the migration", async () => {
    const msg = await loadErrors(requirement({ "@status": "abandoned" }));
    expect(msg).toContain("retired in 0.24.0");
    expect(msg).toContain("docs/features/migrations/verified-by-retirement.md");
    // The surviving members still surface — the reader needs both halves.
    expect(msg).toContain("planned, live, partial");
  });

  test("a surviving member loads clean", async () => {
    expect(await loadErrors(requirement({ "@status": "partial" }))).toBe("");
  });
});

describe("a genuine typo stays generic", () => {
  // The map must not make every failure sound like a retirement. This is the common case
  // and it has to keep pointing at the registry, not at a migration guide.
  test("an invented attribute reports as undeclared, with no migration pointer", async () => {
    const msg = await loadErrors(requirement({ "@verifiedByy": ["X"] }));
    expect(msg).toContain("not declared by any registered provider");
    expect(msg).not.toContain("retired in");
    expect(msg).not.toContain("docs/features/migrations/");
  });

  test("a bogus @status value reports the allowed set with no retirement claim", async () => {
    const msg = await loadErrors(requirement({ "@status": "abandonned" }));
    expect(msg).toContain("planned, live, partial");
    expect(msg).not.toContain("retired in");
  });

  // Scoping is the guard against the map over-claiming. `@readOnly` was retired from
  // FIELDS; on a requirement it was never vocabulary at all, so it must report generically.
  // Getting this wrong would tell an author their typo was a retirement and send them to a
  // migration guide that says nothing about it.
  test("a retired-elsewhere name stays generic on a type it never belonged to", async () => {
    const msg = await loadErrors(requirement({ "@readOnly": true }));
    expect(msg).toContain("not declared by any registered provider");
    expect(msg).not.toContain("retired in");
  });
});

describe("@readOnly on a FIELD — where it really was retired", () => {
  test("names @mutability as the replacement", async () => {
    const msg = await loadErrors({
      "metadata.root": {
        package: "acme::shop",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "ref", "@readOnly": true } },
                { "source.rdb": { "@table": "orders" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    });
    expect(msg).toContain("retired in 0.24.0");
    expect(msg).toContain("@mutability");
    expect(msg).toContain("docs/features/migrations/readonly-to-mutability.md");
  });
});

describe("#337 — a retired SUBTYPE explains itself", () => {
  test("origin.collection names its replacement and guide", async () => {
    const msg = await loadErrors({
      "metadata.root": {
        package: "acme::shop",
        children: [
          {
            "object.projection": {
              name: "OrderView",
              children: [
                {
                  "field.string": {
                    name: "labels",
                    children: [{ "origin.collection": { "@via": "Order.lines" } }],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(msg).toContain("origin.collection");
    expect(msg).toContain("retired in 0.24.0");
    expect(msg).toContain("origin.aggregate @agg: collect");
    expect(msg).toContain("docs/features/migrations/origin-collection-retirement.md");
  });
});

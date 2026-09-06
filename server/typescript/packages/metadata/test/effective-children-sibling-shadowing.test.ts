// An own child may be shadowed by its SUPER's child — never by a later own SIBLING.
//
// `_effectiveChildren` writes a shadowing own child straight into `result[idx]`, and the
// entry stays visible to the NEXT own sibling's scan. So a second own child sharing the
// same `(type, name)` finds its own sibling sitting where the super's child used to be
// and overwrites it. `extends` decides what a child overrides; a sibling is not a super.
//
// The append queue already handles the case where the super declares NOTHING matching —
// a non-shadowing own child is deferred, so it cannot be matched by a later sibling. The
// hole is the other branch: an own child that DID shadow something is left in place,
// unguarded.
//
// WHY THE SHAPE IS NOT EXOTIC. Two children collide on `(type, name)` most easily when
// BOTH ARE UNNAMED, and the everyday model declaring two unnamed children of one type is
// a WRITE-THROUGH ENTITY: `source.rdb @role: primary` for writes, `source.rdb @role:
// replica` for reads. Give its abstract base a source too — the ordinary way a base
// states the default table for a family — and the entity's own PRIMARY is silently
// dropped. `primaryRdbSource` reads `children()`, so the cost is not cosmetic: no table
// for the router or the filter allowlist, no names artifact, and the runtime falling
// through to the replica view.
import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader, InMemoryStringSource, isMetaSource, primaryRdbSource,
} from "../src/index.js";
import type { MetaObject } from "../src/index.js";

// Both halves are load-bearing: with no super the merge loop never runs, and with only
// one own source nothing collides. The base declaring its OWN source is what makes the
// first own source take the `result[idx] = own` branch rather than the append queue.
const MODEL = {
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Base",
          abstract: true,
          children: [
            { "field.long": { name: "id" } },
            { "source.rdb": { "@table": "acct_tbl", "@role": "primary" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Acct",
          extends: "Base",
          children: [
            { "source.rdb": { "@table": "acct_tbl", "@role": "primary" } },
            { "source.rdb": { "@kind": "view", "@view": "acct_vw", "@role": "replica" } },
            { "field.string": { name: "memo" } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
    ],
  },
};

async function acct(): Promise<MetaObject> {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "wt.json" }),
  ]);
  expect(errors.map((e) => e.message)).toEqual([]);
  return root.objects().find((o) => o.name === "Acct") as MetaObject;
}

describe("an own child is shadowed by its super, never by a sibling", () => {
  test("a write-through entity whose BASE also declares a source keeps both of its own", async () => {
    // isMetaSource, not `c.type === "source"` + a cast: the guard is what the package
    // exports for this, and it narrows, so `.role` needs no double cast to reach.
    const sources = (await acct()).children().filter(isMetaSource).map((s) => s.role);
    // Before the fix this was ["replica"] — the entity's own primary overwritten by its
    // own sibling, and the base's source gone too, so the object had exactly one source
    // where it declared two.
    expect(sources.sort()).toEqual(["primary", "replica"]);
  });

  test("...so its primary source still resolves", async () => {
    const src = primaryRdbSource(await acct());
    expect(src).toBeDefined();
    expect(src?.physicalName).toBe("acct_tbl");
  });
});

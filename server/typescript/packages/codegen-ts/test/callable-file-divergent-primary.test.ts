// The callable wrapper inherits the primary-source divergence refusal.
//
// `callableSource` selects an entity's `source.rdb` by @kind (storedProc /
// tableFunction) with NO role filter, and `renderCallableFile` reads `physicalName`
// off it — a THIRD door into "what relation does this object name", reached by
// `callableFile()` alone with no table-name resolver anywhere on the path. Before the
// refusal moved into `primaryRdbSource`, a run wiring only `callableFile()` emitted a
// wrapper bound to the INHERITED parent's procedure for an object every other tier
// refuses. A refusal that depends on which generators ran is not a refusal.
//
// The fixture is asserted to load with ZERO errors first, and both primaries are pinned
// as surviving the child merge — a guard test whose fixture the loader would reject, or
// whose two sources shadow into one, proves nothing.

import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  MetaModelError,
  isMetaSource,
  SOURCE_ROLE_PRIMARY,
  type MetaObject,
  type MetaSource,
} from "@metaobjectsdev/metadata";
import { isCallableEntity, renderCallableFile } from "../src/templates/callable-file.js";

async function loadClean(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "acme", children } });
  const r = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(r.errors.map((e) => e.message)).toEqual([]);
  return r.root;
}

// An abstract projection declaring a callable primary source, and an entity extending it
// that declares its own table. `validateSourceRoles` enforces "exactly one primary" over
// ownChildren() only, so both survive on the child's effective children() with different
// physical names.
const DIVERGENT_CALLABLE = [
  {
    "object.projection": {
      name: "ParentProc",
      abstract: true,
      children: [
        { "source.rdb": { name: "procSrc", "@kind": "storedProc", "@proc": "parent_proc" } },
        { "field.long": { name: "id" } },
      ],
    },
  },
  {
    "object.entity": {
      name: "ChildWeird",
      extends: "ParentProc",
      children: [
        { "source.rdb": { name: "childSrc", "@table": "child_table" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ],
    },
  },
];

describe("renderCallableFile — divergent primary sources", () => {
  test("refuses instead of binding the inherited procedure", async () => {
    const root = await loadClean(DIVERGENT_CALLABLE);
    const child = root.children().find((c) => c.name === "ChildWeird")! as MetaObject;

    const primaries = child.children()
      .filter((c): c is MetaSource => isMetaSource(c) && c.role === SOURCE_ROLE_PRIMARY)
      .map((s) => s.physicalName)
      .sort();
    expect(primaries).toEqual(["child_table", "parent_proc"]);

    // The generator's filter still says yes — this object DOES have a callable source.
    // That gate resolves no name, so it is presence, not agreement, and must not throw.
    expect(isCallableEntity(child)).toBe(true);

    expect(() => renderCallableFile(child)).toThrow(MetaModelError);
    // Each substring separately, so a message dropping one still fails.
    expect(() => renderCallableFile(child)).toThrow(/ChildWeird/);
    expect(() => renderCallableFile(child)).toThrow(/parent_proc/);
    expect(() => renderCallableFile(child)).toThrow(/child_table/);
  });

  test("a single callable primary source still renders — the refusal is about DISAGREEMENT", async () => {
    const root = await loadClean([
      {
        "object.projection": {
          name: "PhaseSummary",
          children: [
            { "source.rdb": { name: "procSrc", "@kind": "storedProc", "@proc": "phase_summary" } },
            { "field.long": { name: "id" } },
          ],
        },
      },
    ]);
    const proj = root.children().find((c) => c.name === "PhaseSummary")! as MetaObject;
    expect(isCallableEntity(proj)).toBe(true);
    expect(renderCallableFile(proj)).toContain("phase_summary");
  });
});

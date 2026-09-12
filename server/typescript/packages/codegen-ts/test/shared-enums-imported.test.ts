// FR-023 §11.1 item 2 — the shared-enums module must honour the same
// model-wide `select` predicate codegen selection uses everywhere else.
//
// `renderSharedEnumsFile` walks the WHOLE loaded root (it has to — the module
// is emitted once per run, not per generator invocation), so without a
// `select` knob it would materialize a shared enum consumed ONLY by an
// imported, out-of-scope entity — the exact silent-wrong-output failure mode
// FR-023's default-exclusion rule exists to prevent (see task-10-brief.md).
//
// `select(entity.resolutionKey())` decides which CONSUMING entities count
// toward "is this enum actually used" — not which enum declarations exist.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { renderSharedEnumsFile } from "../src/templates/enums-file.js";

/**
 * Two packages, one shared enum: `lib::Status` (abstract, root-level) is
 * extended by a field on BOTH `lib::Thing` and `app::Order` — so the enum is
 * "used" from two different packages, and `select` can admit one while
 * excluding the other.
 */
async function loadRoot(): Promise<MetaRoot> {
  const lib = {
    "metadata.root": {
      package: "lib",
      children: [
        { "field.enum": { name: "Status", abstract: true, "@values": ["a", "b"] } },
        {
          "object.entity": {
            name: "Thing",
            children: [
              { "field.long": { name: "id" } },
              { "field.enum": { name: "status", extends: "lib::Status" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
      ],
    },
  };
  const app = {
    "metadata.root": {
      package: "app",
      children: [
        {
          "object.entity": {
            name: "Order",
            children: [
              { "field.long": { name: "id" } },
              { "field.enum": { name: "status", extends: "lib::Status" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
      ],
    },
  };
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(lib)),
    new InMemoryStringSource(JSON.stringify(app)),
  ]);
  expect(result.errors).toEqual([]);
  return result.root;
}

describe("renderSharedEnumsFile — select (FR-023)", () => {
  test("a select admitting only the consumer that uses the enum still materializes it", async () => {
    const root = await loadRoot();
    const out = renderSharedEnumsFile(root, { select: (fqn) => fqn === "app::Order" });
    expect(out).not.toBeNull();
    expect(out).toContain("Status");
  });

  test("a select admitting nothing materializes no shared enum at all", async () => {
    const root = await loadRoot();
    const out = renderSharedEnumsFile(root, { select: () => false });
    expect(out).toBeNull();
  });

  test("no select is byte-identical to today's (unfiltered) output", async () => {
    const root = await loadRoot();
    const withoutOpts = renderSharedEnumsFile(root);
    const withUndefinedSelect = renderSharedEnumsFile(root, {});
    expect(withoutOpts).not.toBeNull();
    expect(withoutOpts).toContain("Status");
    expect(withUndefinedSelect).toBe(withoutOpts);
  });
});

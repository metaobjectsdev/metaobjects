// Cross-realm node guards — see src/shared/node-guards.ts for the mechanism.
//
// These guards exist so cross-package callers (codegen-ts / migrate-ts /
// runtime-ts) never identify a node with `instanceof`, which silently fails when
// two physical copies of this package are loaded in one process. The tests below
// pin both halves: the guards agree with `instanceof` on ordinary same-copy
// nodes, and keep answering correctly for a node whose class identity has been
// split off.

import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  MetaRoot,
  MetaObject,
  MetaField,
  MetaSource,
  TYPE_SOURCE,
  isMetaRoot,
  isMetaObject,
  isMetaField,
  isMetaSource,
  isWritableSource,
  isReadOnlySource,
} from "../src/index.js";
import type { MetaData } from "../src/index.js";

async function loadRoot(): Promise<MetaData> {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "acme::probe",
          children: [
            {
              // Write-through: one writable table source + one read-only replica
              // view source, so both writability arms are reachable on one entity.
              "object.entity": {
                name: "Order",
                children: [
                  { "field.long": { name: "id" } },
                  { "source.rdb": { name: "tbl", "@table": "orders", "@role": "primary" } },
                  {
                    "source.rdb": {
                      name: "vw",
                      "@table": "v_order",
                      "@kind": "view",
                      "@role": "replica",
                    },
                  },
                  { "identity.primary": { name: "pk", "@fields": ["id"] } },
                ],
              },
            },
          ],
        },
      }),
    ),
  ]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

/**
 * Simulate a second physical copy of this package: clone the node's prototype
 * (keeping every method and getter, and the MetaData base above it) and re-seat
 * the node on the clone, so `instanceof` against this copy's class is false while
 * behaviour is unchanged.
 */
function intoForeignRealm(node: MetaData): void {
  const ownProto = Object.getPrototypeOf(node) as object;
  const foreignProto = Object.create(Object.getPrototypeOf(ownProto) as object) as object;
  for (const key of Reflect.ownKeys(ownProto)) {
    if (key === "constructor") continue;
    const d = Object.getOwnPropertyDescriptor(ownProto, key);
    if (d !== undefined) Object.defineProperty(foreignProto, key, d);
  }
  Object.setPrototypeOf(node, foreignProto);
}

describe("cross-realm node guards", () => {
  test("agree with instanceof on ordinary same-copy nodes", async () => {
    const root = await loadRoot();
    const order = root.children()[0] as MetaData;
    const field = order.children().find((c) => c.type === "field") as MetaData;
    const source = order.children().find((c) => c.type === TYPE_SOURCE) as MetaData;

    expect([isMetaRoot(root), root instanceof MetaRoot]).toEqual([true, true]);
    expect([isMetaObject(order), order instanceof MetaObject]).toEqual([true, true]);
    expect([isMetaField(field), field instanceof MetaField]).toEqual([true, true]);
    expect([isMetaSource(source), source instanceof MetaSource]).toEqual([true, true]);
  });

  test("do not confuse one node type for another", async () => {
    const root = await loadRoot();
    const order = root.children()[0] as MetaData;
    const source = order.children().find((c) => c.type === TYPE_SOURCE) as MetaData;

    expect(isMetaSource(order)).toBe(false);
    expect(isMetaObject(source)).toBe(false);
    expect(isMetaRoot(order)).toBe(false);
    expect(isMetaField(source)).toBe(false);
  });

  test("reject non-nodes without throwing", () => {
    for (const junk of [undefined, null, 42, "source", {}, { type: 7 }, []]) {
      expect(isMetaSource(junk)).toBe(false);
      expect(isMetaRoot(junk)).toBe(false);
      expect(isMetaObject(junk)).toBe(false);
      expect(isMetaField(junk)).toBe(false);
    }
  });

  test("keep answering when class identity is split (the whole point)", async () => {
    const root = await loadRoot();
    const order = root.children()[0] as MetaData;
    const source = order.children().find((c) => c.type === TYPE_SOURCE) as MetaData;

    intoForeignRealm(root);
    intoForeignRealm(order);
    intoForeignRealm(source);

    // instanceof is now false for all three — the split-tree condition...
    expect(root instanceof MetaRoot).toBe(false);
    expect(order instanceof MetaObject).toBe(false);
    expect(source instanceof MetaSource).toBe(false);

    // ...and the guards are unaffected.
    expect(isMetaRoot(root)).toBe(true);
    expect(isMetaObject(order)).toBe(true);
    expect(isMetaSource(source)).toBe(true);
  });

  test("writability is read through the node, so it survives the split too", async () => {
    const root = await loadRoot();
    const sources = (root.children()[0] as MetaData)
      .children()
      .filter((c) => c.type === TYPE_SOURCE);
    const table = sources[0] as MetaData;
    const view = sources[1] as MetaData;

    intoForeignRealm(table);
    intoForeignRealm(view);

    expect([isWritableSource(table), isReadOnlySource(table)]).toEqual([true, false]);
    // The read-only kind stays read-only — the guard reads @kind, it does not
    // assume every source it can see is writable.
    expect([isWritableSource(view), isReadOnlySource(view)]).toEqual([false, true]);
  });

  test("fail closed for a source that cannot answer", async () => {
    const root = await loadRoot();
    const source = (root.children()[0] as MetaData)
      .children()
      .find((c) => c.type === TYPE_SOURCE) as MetaData;
    // A node carrying type=source but none of the source behaviour (a shape no
    // registry produces, but the guard must not throw on it).
    Object.setPrototypeOf(source, Object.getPrototypeOf(root.children()[0] as MetaData));

    expect(isMetaSource(source)).toBe(true);
    expect(isWritableSource(source)).toBe(false);
    expect(isReadOnlySource(source)).toBe(false);
  });
});

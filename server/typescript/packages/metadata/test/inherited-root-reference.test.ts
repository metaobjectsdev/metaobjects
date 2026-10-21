// ADR-0059 Decisions 6 and 7: a root-level declarer writes a root target bare, and a bare
// canonical value means the ROOT-level object. A consumer reading it through an inheritor
// in another package must still bind the root object, never the inheritor's same-named one.
// Model: `fixtures/codegen-conformance/cross-package-binding/` — root `BaseOrder` writes
// `Customer` and `Label` bare; `acme::Order` extends it while `acme::Customer` and
// `acme::Label` exist and load first.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { lookupCanonical, refTarget } from "../src/naming-refs.js";
import { deriveM2MFields } from "../src/core/relationship/derive-m2m-fields.js";
import { IDENTITY_REFERENCE_ATTR_REFERENCES } from "../src/core/identity/identity-constants.js";
import { RELATIONSHIP_ATTR_OBJECT_REF, RELATIONSHIP_ATTR_THROUGH } from "../src/core/relationship/relationship-constants.js";
import type { MetaObject } from "../src/core/object/meta-object.js";
import type { MetaRoot } from "../src/shared/meta-root.js";

function repoRoot(start: string): string {
  let dir = start;
  while (!(existsSync(join(dir, "fixtures")) && existsSync(join(dir, "server")))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
  return dir;
}

async function load(): Promise<MetaRoot> {
  const dir = join(repoRoot(import.meta.dir), "fixtures", "codegen-conformance", "cross-package-binding", "input");
  const sources = readdirSync(dir)
    .sort()
    .map((f) => new InMemoryStringSource(readFileSync(join(dir, f), "utf-8"), { id: f, format: "json" }));
  const { root, errors } = await new MetaDataLoader().load(sources);
  expect(errors).toEqual([]);
  return root;
}

const byKey = (root: MetaRoot, key: string): MetaObject =>
  root.objects().find((o) => o.resolutionKey() === key)!;

describe("an inherited bare canonical reference binds the root object", () => {
  test("refTarget and lookupCanonical bind the root Customer from acme::Order", async () => {
    const root = await load();
    const order = byKey(root, "acme::Order");
    const rel = order.relationships().find((r) => r.name === "customer")!;
    const ref = order.referenceIdentities().find((r) => r.name === "customerRef")!;
    expect(rel.attr(RELATIONSHIP_ATTR_OBJECT_REF)).toBe("Customer");
    expect(refTarget(rel, RELATIONSHIP_ATTR_OBJECT_REF)).toBe(byKey(root, "Customer"));
    expect(refTarget(ref, IDENTITY_REFERENCE_ATTR_REFERENCES)).toBe(byKey(root, "Customer"));
    expect(lookupCanonical(root, "Customer")).toBe(byKey(root, "Customer"));
    expect(lookupCanonical(root, "acme::Customer")).toBe(byKey(root, "acme::Customer"));
  });

  test("the M:N derivation from acme::Order uses the root junction and the root Label", async () => {
    const root = await load();
    const order = byKey(root, "acme::Order");
    const rel = order.relationships().find((r) => r.name === "labels")!;
    expect(refTarget(rel, RELATIONSHIP_ATTR_THROUGH)).toBe(byKey(root, "OrderLabel"));
    expect(refTarget(rel, RELATIONSHIP_ATTR_OBJECT_REF)).toBe(byKey(root, "Label"));
    expect(deriveM2MFields(rel, order, root)).toEqual({ sourceField: "orderId", targetField: "labelId" });
  });
});

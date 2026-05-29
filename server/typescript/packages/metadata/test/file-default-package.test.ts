// file-default-package.test.ts
//
// Regression: a fully-qualified `extends:` that names a supertype by its
// file-default package (the top-level `metadata.package`) must RESOLVE, even
// though the supertype's own node carries no explicit `package:` key.
//
// Java's BaseMetaDataParser folds the file-default package into the registered
// NAME (so an object `BaseEntity` under `package: acme::common` is
// registered as `acme::common::BaseEntity`, and `extends:
// acme::common::BaseEntity` resolves). The TS parser keeps object `fqn()`
// BARE on purpose — the FR5d referrer-envelope cross-port contract relies on it
// (see Fr5dReferenceResolutionTest: "TS's MetaData.fqn() does NOT propagate the
// root package; Java uses getShortName() to match"). So the bug is NOT that the
// object FQN should gain the package — it is that SUPER RESOLUTION must match a
// node by its EFFECTIVE qualified name (inheritedPkg::name) even when the node's
// fqn() is bare. Without that, the cross-ref silently fails to resolve and
// downstream `meta gen` breaks.

import { test, expect } from "bun:test";
import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import { parseYaml } from "../src/core/parser-yaml.js";
import { TYPE_OBJECT } from "../src/shared/base-types.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

function coreRegistry(): TypeRegistry {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  return registry;
}

// ---------------------------------------------------------------------------
// 1) Same-file extends by fully-qualified (file-default) name resolves.
// ---------------------------------------------------------------------------

test("same-file extends by file-default-qualified name resolves", () => {
  const yaml = `
metadata:
  package: acme::lms
  children:
    - object.entity:
        name: BaseEntity
        abstract: true
        children:
          - field.string: { name: id }
    - object.entity:
        name: Course
        extends: acme::lms::BaseEntity
        children:
          - field.string: { name: title }
`;
  const result = parseYaml(yaml, { registry: coreRegistry() });
  expect(result.errors).toEqual([]);

  const base = result.root.childByTypeAndName(TYPE_OBJECT, "BaseEntity")!;
  const course = result.root.childByTypeAndName(TYPE_OBJECT, "Course")!;

  // Cross-port contract: object fqn() stays BARE (TS does not propagate the
  // file-default package into the node's fqn — Java mirrors this via
  // getShortName() for FR5d envelopes).
  expect(base.fqn()).toBe("BaseEntity");
  expect(course.fqn()).toBe("Course");

  // The super must RESOLVE despite the fully-qualified ref — this is the fix.
  expect(course.superData).toBeDefined();
  expect(course.superData).toBe(base);
});

// ---------------------------------------------------------------------------
// 2) Fields within objects keep simple names (unchanged behavior).
// ---------------------------------------------------------------------------

test("fields within objects keep simple names", () => {
  const yaml = `
metadata:
  package: acme::lms
  children:
    - object.entity:
        name: Course
        children:
          - field.string: { name: id }
`;
  const result = parseYaml(yaml, { registry: coreRegistry() });
  expect(result.errors).toEqual([]);

  const course = result.root.childByTypeAndName(TYPE_OBJECT, "Course")!;
  const id = course.ownChildren().find((c) => c.name === "id");
  expect(id).toBeDefined();
  expect(id!.package).toBeUndefined();
  expect(id!.fqn()).toBe("id");
});

// ---------------------------------------------------------------------------
// 3) Cross-file extends by fully-qualified (file-default) name resolves.
//    The base entity declares no explicit package; the fully-qualified ref
//    `acme::common::BaseEntity` must still resolve through the loader.
// ---------------------------------------------------------------------------

test("cross-file extends by file-default-qualified name resolves", async () => {
  const baseYaml = `
metadata:
  package: acme::common
  children:
    - object.entity:
        name: BaseEntity
        abstract: true
        children:
          - field.string: { name: id }
`;
  const courseYaml = `
metadata:
  package: acme::common
  children:
    - object.entity:
        name: Course
        extends: acme::common::BaseEntity
        children:
          - field.string: { name: title }
`;

  const loader = new MetaDataLoader({ registry: coreRegistry() });
  const result = await loader.load([
    new InMemoryStringSource(baseYaml, { id: "base.yaml", format: "yaml" }),
    new InMemoryStringSource(courseYaml, { id: "course.yaml", format: "yaml" }),
  ]);
  expect(result.errors).toEqual([]);

  const base = loader.root.childByTypeAndName(TYPE_OBJECT, "BaseEntity")!;
  const course = loader.root.childByTypeAndName(TYPE_OBJECT, "Course")!;

  // Bare fqn() — cross-port contract.
  expect(base.fqn()).toBe("BaseEntity");
  expect(course.fqn()).toBe("Course");

  // Super resolves across files via the file-default-qualified ref.
  expect(course.superData).toBeDefined();
  expect(course.superData).toBe(base);
});

// ---------------------------------------------------------------------------
// 4) Cross-PACKAGE cross-file extends by fully-qualified (file-default) name.
//    The base entity lives in a DIFFERENT file-default package (acme::common)
//    from the concrete entity (acme::lms). Loaded concrete-FIRST, so the base
//    node does not yet exist when Course is parsed — deferred resolution must
//    match it by its file-default-qualified key (acme::common::BaseTenantEntity)
//    regardless of merge order. This is the real downstream shape.
// ---------------------------------------------------------------------------

test("cross-PACKAGE cross-file extends resolves (concrete loaded first)", async () => {
  const baseYaml = `
metadata:
  package: acme::common
  children:
    - object.entity:
        name: BaseTenantEntity
        abstract: true
        children:
          - field.string: { name: id }
`;
  const courseYaml = `
metadata:
  package: acme::lms
  children:
    - object.entity:
        name: Course
        extends: acme::common::BaseTenantEntity
        children:
          - field.string: { name: title }
`;

  const loader = new MetaDataLoader({ registry: coreRegistry() });
  const result = await loader.load([
    // concrete FIRST — base not yet present when Course's super is parsed.
    new InMemoryStringSource(courseYaml, { id: "lms.yaml", format: "yaml" }),
    new InMemoryStringSource(baseYaml, { id: "common.yaml", format: "yaml" }),
  ]);
  expect(result.errors).toEqual([]);

  const base = loader.root.childByTypeAndName(TYPE_OBJECT, "BaseTenantEntity")!;
  const course = loader.root.childByTypeAndName(TYPE_OBJECT, "Course")!;

  // Bare fqn() — cross-port contract (FR5d).
  expect(base.fqn()).toBe("BaseTenantEntity");
  expect(course.fqn()).toBe("Course");

  // Super resolves across packages + files via the file-default-qualified ref.
  expect(course.superData).toBeDefined();
  expect(course.superData).toBe(base);
});

// ---------------------------------------------------------------------------
// 5) Same as #4 but load-order REVERSED (base first). Resolution must be
//    order-independent: the file-default-package key is captured at PARSE time,
//    not derived from the post-merge tree, so either order resolves.
// ---------------------------------------------------------------------------

test("cross-PACKAGE cross-file extends resolves (base loaded first)", async () => {
  const baseYaml = `
metadata:
  package: acme::common
  children:
    - object.entity:
        name: BaseTenantEntity
        abstract: true
        children:
          - field.string: { name: id }
`;
  const courseYaml = `
metadata:
  package: acme::lms
  children:
    - object.entity:
        name: Course
        extends: acme::common::BaseTenantEntity
        children:
          - field.string: { name: title }
`;

  const loader = new MetaDataLoader({ registry: coreRegistry() });
  const result = await loader.load([
    new InMemoryStringSource(baseYaml, { id: "common.yaml", format: "yaml" }),
    new InMemoryStringSource(courseYaml, { id: "lms.yaml", format: "yaml" }),
  ]);
  expect(result.errors).toEqual([]);

  const base = loader.root.childByTypeAndName(TYPE_OBJECT, "BaseTenantEntity")!;
  const course = loader.root.childByTypeAndName(TYPE_OBJECT, "Course")!;

  expect(base.fqn()).toBe("BaseTenantEntity");
  expect(course.fqn()).toBe("Course");

  expect(course.superData).toBeDefined();
  expect(course.superData).toBe(base);
});

// Runtime object-model conformance runner (TS port).
//
// Drives the shared corpus at fixtures/object-model-conformance/ (repo root)
// through the TS runtime object model: MetaObject.newInstance(), ValueObject,
// MetaField.getValue/setValue, and ObjectClassRegistry binding. The 7 scenarios
// in the corpus README are the behavioral contract — assertions are behavioral
// (type-kind, back-ref identity, field values, list contents, overflow), not
// byte-identity.
//
// This file lives at typescript/packages/metadata/test/. The corpus is at the
// REPO ROOT — five `../` levels up from test/ (test → metadata → packages →
// typescript → server → repo-root).

import { test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { loadDirectory } from "../src/loader/shortcuts.js";
import type { MetaRoot } from "../src/shared/meta-root.js";
import type { MetaObject } from "../src/core/object/meta-object.js";
import type { MetaField } from "../src/core/field/meta-field.js";
import { ValueObject } from "../src/core/object/value-object.js";
import { ObjectClassRegistry } from "../src/core/object/object-class-registry.js";
import {
  type MetaObjectAware,
} from "../src/core/object/meta-object-aware.js";

const CORPUS =
  process.env.METAOBJECTS_OBJECT_MODEL_CORPUS ??
  join(import.meta.dir, "../../../../../fixtures/object-model-conformance");

const PERSON_FQN = "com::example::om::Person";

let root: MetaRoot;
let person: MetaObject;
let address: MetaObject;
let tag: MetaObject;

/** Resolve a field's nested object-ref target MetaObject via the root index. */
function resolveObjectRef(field: MetaField): MetaObject {
  const ref = field.objectRef;
  if (ref === undefined) {
    throw new Error(`field ${field.name} has no @objectRef`);
  }
  const target = root.objects().find((o) => o.resolutionKey() === ref);
  if (target === undefined) {
    throw new Error(`no object found for @objectRef ${ref}`);
  }
  return target;
}

beforeAll(async () => {
  const result = await loadDirectory(CORPUS);
  expect(result.errors).toEqual([]);
  root = result.root;

  const p = root.findObject("Person");
  const a = root.findObject("Address");
  const t = root.findObject("Tag");
  if (p === undefined || a === undefined || t === undefined) {
    throw new Error("corpus missing Person/Address/Tag");
  }
  person = p;
  address = a;
  tag = t;
});

// 1. instantiate-value -------------------------------------------------------
test("scenario 1: instantiate-value → ValueObject with Person back-ref", () => {
  const inst = person.newInstance();
  expect(inst).toBeInstanceOf(ValueObject);
  expect((inst as ValueObject).getMetaData()).toBe(person);
});

// 2. scalar-round-trip -------------------------------------------------------
test("scenario 2: scalar round-trip via field setValue/getValue", () => {
  const inst = person.newInstance();
  const nameField = person.getMetaField("name")!;
  const ageField = person.getMetaField("age")!;

  nameField.setValue(inst, "Ada");
  ageField.setValue(inst, 36);

  expect(nameField.getValue(inst)).toBe("Ada");
  const age = ageField.getValue(inst);
  expect(age).toBe(36);
  expect(typeof age).toBe("number");
});

// 3. nested-object -----------------------------------------------------------
test("scenario 3: nested object round-trip with back-ref", () => {
  const personInst = person.newInstance();
  const homeField = person.getMetaField("home")!;

  const addressMo = resolveObjectRef(homeField);
  expect(addressMo).toBe(address);

  const addressInst = addressMo.newInstance();
  address.getMetaField("street")!.setValue(addressInst, "1 Main");
  address.getMetaField("city")!.setValue(addressInst, "Anytown");

  homeField.setValue(personInst, addressInst);

  const gotHome = homeField.getValue(personInst) as ValueObject;
  expect(address.getMetaField("street")!.getValue(gotHome)).toBe("1 Main");
  expect(address.getMetaField("city")!.getValue(gotHome)).toBe("Anytown");
  expect(gotHome.getMetaData()).toBe(address);
});

// 4. array-of-objects --------------------------------------------------------
test("scenario 4: array of objects round-trip with per-element back-refs", () => {
  const personInst = person.newInstance();
  const tagsField = person.getMetaField("tags")!;
  expect(tagsField.isArray).toBe(true);

  const tagMo = resolveObjectRef(tagsField);
  expect(tagMo).toBe(tag);

  const tagA = tagMo.newInstance();
  tag.getMetaField("label")!.setValue(tagA, "a");
  const tagB = tagMo.newInstance();
  tag.getMetaField("label")!.setValue(tagB, "b");

  tagsField.setValue(personInst, [tagA, tagB]);

  const gotTags = tagsField.getValue(personInst) as ValueObject[];
  expect(Array.isArray(gotTags)).toBe(true);
  expect(gotTags.length).toBe(2);
  expect(tag.getMetaField("label")!.getValue(gotTags[0]!)).toBe("a");
  expect(tag.getMetaField("label")!.getValue(gotTags[1]!)).toBe("b");
  expect((gotTags[0] as ValueObject).getMetaData()).toBe(tag);
  expect((gotTags[1] as ValueObject).getMetaData()).toBe(tag);
});

// 5. overflow ----------------------------------------------------------------
test("scenario 5: overflow key round-trips on a ValueObject", () => {
  const inst = person.newInstance() as ValueObject;
  inst.set("nickname", "Countess");
  expect(inst.get("nickname")).toBe("Countess");
});

// 6. bound-type --------------------------------------------------------------
test("scenario 6: registered native type instantiated + IO identical", () => {
  // A port-local "aware" backing type. Generated code would self-register a
  // factory like this at import time.
  class PersonObj implements MetaObjectAware {
    name?: string;
    age?: number;
    home?: object;
    tags?: object[];
    private _mo: MetaObject | undefined = undefined;
    constructor(mo?: MetaObject) {
      this._mo = mo;
    }
    getMetaData(): MetaObject | undefined {
      return this._mo;
    }
    setMetaData(mo: MetaObject): void {
      this._mo = mo;
    }
  }

  const registry = new ObjectClassRegistry();
  registry.register(PERSON_FQN, (mo) => new PersonObj(mo));

  const inst = person.newInstance(registry);
  expect(inst).toBeInstanceOf(PersonObj);
  expect((inst as PersonObj).getMetaData()).toBe(person);

  // scalar
  person.getMetaField("name")!.setValue(inst, "Ada");
  person.getMetaField("age")!.setValue(inst, 36);
  expect(person.getMetaField("name")!.getValue(inst)).toBe("Ada");
  expect(person.getMetaField("age")!.getValue(inst)).toBe(36);
  expect((inst as PersonObj).name).toBe("Ada");

  // nested (Address falls back to ValueObject — nothing registered for it)
  const homeField = person.getMetaField("home")!;
  const addressInst = resolveObjectRef(homeField).newInstance(registry);
  expect(addressInst).toBeInstanceOf(ValueObject);
  address.getMetaField("street")!.setValue(addressInst, "1 Main");
  homeField.setValue(inst, addressInst);
  const gotHome = homeField.getValue(inst) as ValueObject;
  expect(address.getMetaField("street")!.getValue(gotHome)).toBe("1 Main");

  // array
  const tagsField = person.getMetaField("tags")!;
  const tagMo = resolveObjectRef(tagsField);
  const tagA = tagMo.newInstance(registry);
  tag.getMetaField("label")!.setValue(tagA, "a");
  tagsField.setValue(inst, [tagA]);
  const gotTags = tagsField.getValue(inst) as ValueObject[];
  expect(gotTags.length).toBe(1);
  expect(tag.getMetaField("label")!.getValue(gotTags[0]!)).toBe("a");

  // does not leak into the default registry
  expect(person.newInstance()).toBeInstanceOf(ValueObject);
});

// 7. no-binding-fallback -----------------------------------------------------
test("scenario 7: no binding → ValueObject fallback", () => {
  const empty = new ObjectClassRegistry();
  expect(address.newInstance(empty)).toBeInstanceOf(ValueObject);
  expect(address.newInstance()).toBeInstanceOf(ValueObject);
});

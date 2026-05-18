// Round-trip parity tests — Task 11 of v0.2 SP1
//
// Integration-level sweep: for each Java fixture (or fixture group), loads via
// FileMetaDataLoader, serializes via serializeJson, reloads via a fresh MetaDataLoader, and compares
// both trees structurally. Catches drift between the parser and serializer that
// per-component tests might miss.
//
// Test categories:
//   1. Per-fixture round-trip (6 tests — one per fixture)
//   2. Multi-file dependency order (common → vehicle → overlay)
//   3. Inline-vs-child attr round-trip (valid-complete-metadata.json)
//   4. Empty load
//   5. Per-fixture entity counts
//   6. Super resolution sanity (spot checks)
//   7. Override application sanity (spot checks)

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { FileMetaDataLoader } from "../src/core/file-meta-data-loader.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";
import type { MetaData } from "../src/meta/meta-data.js";
import { serializeJson } from "../src/serializer-json.js";
import {
  TYPE_METADATA,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_ATTR,
  TYPE_IDENTITY,
  TYPE_RELATIONSHIP,
  TYPE_VALIDATOR,
  SUBTYPE_ROOT,
  OBJECT_SUBTYPE_ENTITY,
} from "../src/constants.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url).pathname;

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

// ---------------------------------------------------------------------------
// assertModelsEqual — recursive structural comparator
//
// Compares:
//   - type, subType
//   - name, package
//   - superRef (raw string — superResolved is a runtime pointer, not wire-format)
//   - isAbstract, isArray
//   - attrs Map (size + every key/value match)
//   - children count + recursive comparison (by index)
//
// Does NOT compare:
//   - frozen state (implementation detail)
//   - superResolved (runtime pointer, not wire-format)
//   - isMerge — parse-time provenance flag. The serializer intentionally does
//     NOT emit "merge: true" on merged entities; the round-tripped tree is the
//     canonical merged form where this flag is always false.
// ---------------------------------------------------------------------------

function assertModelsEqual(a: MetaData, b: MetaData, path = "root"): void {
  // Type identity
  if (a.type !== b.type) throw new Error(`${path}: type mismatch — expected "${a.type}", got "${b.type}"`);
  if (a.subType !== b.subType) throw new Error(`${path}: subType mismatch — expected "${a.subType}", got "${b.subType}"`);

  // Name and package
  if (a.name !== b.name) throw new Error(`${path}: name mismatch — expected "${a.name}", got "${b.name}"`);
  if (a.package !== b.package) throw new Error(`${path}: package mismatch — expected "${String(a.package)}", got "${String(b.package)}"`);

  // Super ref (raw string, not resolved pointer)
  if (a.superRef !== b.superRef) throw new Error(`${path}: superRef mismatch — expected "${String(a.superRef)}", got "${String(b.superRef)}"`);

  // Boolean flags (wire-format properties only)
  if (a.isAbstract !== b.isAbstract) throw new Error(`${path}: isAbstract mismatch — expected ${a.isAbstract}, got ${b.isAbstract}`);
  if (a.isArray !== b.isArray) throw new Error(`${path}: isArray mismatch — expected ${a.isArray}, got ${b.isArray}`);

  // Attrs map
  const aAttrs = a.attrs();
  const bAttrs = b.attrs();
  if (aAttrs.size !== bAttrs.size) {
    const aKeys = [...aAttrs.keys()].sort().join(", ");
    const bKeys = [...bAttrs.keys()].sort().join(", ");
    throw new Error(`${path}: attrs.size mismatch — expected ${aAttrs.size} (${aKeys}), got ${bAttrs.size} (${bKeys})`);
  }
  for (const [k, v] of aAttrs) {
    if (!bAttrs.has(k)) throw new Error(`${path}: attrs missing key "${k}"`);
    const bVal = bAttrs.get(k);
    if (Array.isArray(v)) {
      if (!Array.isArray(bVal)) throw new Error(`${path}: attr "${k}" should be array but got ${typeof bVal}`);
      expect(v).toEqual(bVal); // deep equality for arrays
    } else {
      if (bVal !== v) throw new Error(`${path}: attr "${k}" value mismatch — expected ${JSON.stringify(v)}, got ${JSON.stringify(bVal)}`);
    }
  }

  // Children — order must match (round-trip preserves insertion order)
  const aKids = a.ownChildren();
  const bKids = b.ownChildren();
  if (aKids.length !== bKids.length) {
    throw new Error(`${path}: children count mismatch — expected ${aKids.length}, got ${bKids.length}`);
  }
  for (let i = 0; i < aKids.length; i++) {
    assertModelsEqual(aKids[i]!, bKids[i]!, `${path}.children[${i}]`);
  }
}

// ---------------------------------------------------------------------------
// Helper: load a single fixture file via FileMetaDataLoader
// ---------------------------------------------------------------------------

async function loadFixture(name: string): Promise<{ root: MetaData; warnings: string[]; errors: Error[] }> {
  const loader = new FileMetaDataLoader({ freeze: false });
  return loader.loadFiles([fixturePath(name)]);
}

// ---------------------------------------------------------------------------
// Helper: load multiple fixture files in dependency order
// ---------------------------------------------------------------------------

async function loadFixtures(names: string[]): Promise<{ root: MetaData; warnings: string[]; errors: Error[] }> {
  const loader = new FileMetaDataLoader({ freeze: false });
  return loader.loadFiles(names.map(fixturePath));
}

// ---------------------------------------------------------------------------
// Helper: round-trip a root — serialize → fresh MetaDataLoader → parse → return new root
// ---------------------------------------------------------------------------

async function roundTrip(root: MetaData): Promise<MetaData> {
  const serialized = serializeJson(root);
  const loader = new MetaDataLoader({ freeze: false });
  const result = await loader.load([new InMemorySource(serialized, { id: "round-trip" })]);
  if (result.errors.length > 0) {
    throw new Error(
      `Round-trip parse produced errors:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }
  return result.root;
}

// ===========================================================================
// 1. Per-fixture round-trip (one test per fixture)
// ===========================================================================

describe("Round-trip: fruitbasket-metadata.json", () => {
  it("parses without errors", async () => {
    const { errors } = await loadFixture("fruitbasket-metadata.json");
    expect(errors.length).toBe(0);
  });

  it("serialize → reload → trees are semantically equivalent", async () => {
    const { root } = await loadFixture("fruitbasket-metadata.json");
    const reparsed = await roundTrip(root);
    assertModelsEqual(root, reparsed);
  });
});

describe("Round-trip: fruitbasket-proxy-metadata.json", () => {
  it("parses without errors", async () => {
    const { errors } = await loadFixture("fruitbasket-proxy-metadata.json");
    expect(errors.length).toBe(0);
  });

  it("serialize → reload → trees are semantically equivalent", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    const reparsed = await roundTrip(root);
    assertModelsEqual(root, reparsed);
  });
});

describe("Round-trip: acme-common-metadata.json", () => {
  it("parses without errors", async () => {
    const { errors } = await loadFixture("acme-common-metadata.json");
    expect(errors.length).toBe(0);
  });

  it("serialize → reload → trees are semantically equivalent", async () => {
    const { root } = await loadFixture("acme-common-metadata.json");
    const reparsed = await roundTrip(root);
    assertModelsEqual(root, reparsed);
  });
});

describe("Round-trip: acme-vehicle-metadata.json (with acme-common loaded first)", () => {
  it("parses without errors when common is loaded first", async () => {
    const { errors } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
    ]);
    expect(errors.length).toBe(0);
  });

  it("serialize → reload → trees are semantically equivalent", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
    ]);
    const reparsed = await roundTrip(root);
    assertModelsEqual(root, reparsed);
  });
});

describe("Round-trip: acme-vehicle-overlay-metadata.json (common + vehicle + overlay)", () => {
  it("parses without errors in dependency order", async () => {
    const { errors } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    expect(errors.length).toBe(0);
  });

  it("serialize → reload → trees are semantically equivalent", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    const reparsed = await roundTrip(root);
    assertModelsEqual(root, reparsed);
  });
});

describe("Round-trip: valid-complete-metadata.json", () => {
  it("parses without errors", async () => {
    const { errors } = await loadFixture("valid-complete-metadata.json");
    expect(errors.length).toBe(0);
  });

  it("serialize → reload → trees are semantically equivalent", async () => {
    const { root } = await loadFixture("valid-complete-metadata.json");
    const reparsed = await roundTrip(root);
    assertModelsEqual(root, reparsed);
  });
});

// ===========================================================================
// 2. Multi-file dependency order
// ===========================================================================

describe("Multi-file dependency order: common → vehicle → overlay", () => {
  it("loads all three without errors", async () => {
    const { errors } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    expect(errors.length).toBe(0);
  });

  it("merged tree contains common abstract fields and vehicle objects", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    // Abstract fields from common
    expect(root.ownChildByTypeAndName(TYPE_FIELD, "id")).toBeDefined();
    expect(root.ownChildByTypeAndName(TYPE_FIELD, "name")).toBeDefined();
    expect(root.ownChildByTypeAndName(TYPE_FIELD, "description")).toBeDefined();
    // Objects from vehicle
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Garage")).toBeDefined();
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Vehicle")).toBeDefined();
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Car")).toBeDefined();
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Truck")).toBeDefined();
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Motorcycle")).toBeDefined();
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Porsche")).toBeDefined();
  });

  it("overlay file additions are present in merged tree (warranty field on Vehicle)", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    const vehicle = root.ownChildByTypeAndName(TYPE_OBJECT, "Vehicle")!;
    expect(vehicle).toBeDefined();
    expect(vehicle.ownChildByTypeAndName(TYPE_FIELD, "warranty")).toBeDefined();
  });

  it("overlay file additions are present in merged tree (premiumLocation field on Garage)", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    const garage = root.ownChildByTypeAndName(TYPE_OBJECT, "Garage")!;
    expect(garage).toBeDefined();
    expect(garage.ownChildByTypeAndName(TYPE_FIELD, "premiumLocation")).toBeDefined();
  });

  it("overlay file additions are present in merged tree (certifiedPreOwned field on Porsche)", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    const porsche = root.ownChildByTypeAndName(TYPE_OBJECT, "Porsche")!;
    expect(porsche).toBeDefined();
    expect(porsche.ownChildByTypeAndName(TYPE_FIELD, "certifiedPreOwned")).toBeDefined();
  });

  it("round-trips correctly after multi-file merge", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    const reparsed = await roundTrip(root);
    assertModelsEqual(root, reparsed);
  });
});

// ===========================================================================
// 3. Inline-vs-child attr round-trip (valid-complete-metadata.json)
// ===========================================================================

describe("Inline-vs-child attr round-trip: valid-complete-metadata.json", () => {
  // This fixture has BOTH forms:
  //   - inline @-attrs: "@required": true, "@maxLength": 50, "@generation": "increment"
  //   - child {"attr":{...}} nodes: {"attr": {"name": "format", "subType": "string", "value": "yyyy-MM-dd"}}
  //
  // After round-trip, semantics must be preserved. The serializer prefers inline form
  // for type-inferrable attrs, so child-form inputs may come back as inline outputs;
  // that's acceptable as long as the attr value (via setAttr) is preserved.

  it("User object is present after parse", async () => {
    const { root } = await loadFixture("valid-complete-metadata.json");
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "User")).toBeDefined();
  });

  it("User.id has @required attr set to true (inline form)", async () => {
    const { root } = await loadFixture("valid-complete-metadata.json");
    const user = root.ownChildByTypeAndName(TYPE_OBJECT, "User")!;
    const idField = user.ownChildByTypeAndName(TYPE_FIELD, "id")!;
    expect(idField).toBeDefined();
    expect(idField.attr("required")).toBe(true);
  });

  it("User.createdDate has format attr from child attr node", async () => {
    const { root } = await loadFixture("valid-complete-metadata.json");
    const user = root.ownChildByTypeAndName(TYPE_OBJECT, "User")!;
    const createdDate = user.ownChildByTypeAndName(TYPE_FIELD, "createdDate")!;
    expect(createdDate).toBeDefined();
    // The "format" attr was set via a child {"attr":{...}} node
    expect(createdDate.attr("format")).toBe("yyyy-MM-dd");
  });

  it("attrs are semantically preserved after round-trip (assertModelsEqual passes)", async () => {
    const { root } = await loadFixture("valid-complete-metadata.json");
    const reparsed = await roundTrip(root);
    assertModelsEqual(root, reparsed);
  });

  it("User.username attrs (inline @maxLength and @pattern) survive round-trip", async () => {
    const { root } = await loadFixture("valid-complete-metadata.json");
    const user = root.ownChildByTypeAndName(TYPE_OBJECT, "User")!;
    const usernameField = user.ownChildByTypeAndName(TYPE_FIELD, "username")!;
    expect(usernameField).toBeDefined();

    // After round-trip, attrs should still be present
    const reparsed = await roundTrip(root);
    const reparsedUser = reparsed.ownChildByTypeAndName(TYPE_OBJECT, "User")!;
    const reparsedUsername = reparsedUser.ownChildByTypeAndName(TYPE_FIELD, "username")!;
    expect(reparsedUsername.attr("maxLength")).toBe(50);
    expect(reparsedUsername.attr("pattern")).toBe("^[a-zA-Z0-9_]+$");
  });
});

// ===========================================================================
// 4. Empty load
// ===========================================================================

describe("Empty load", () => {
  it("loader with no sources returns root typed as metadata.root", async () => {
    const loader = new MetaDataLoader({ freeze: false });
    const { root, errors, warnings } = await loader.load([]);
    expect(root.type).toBe(TYPE_METADATA);
    expect(root.subType).toBe(SUBTYPE_ROOT);
    expect(errors.length).toBe(0);
    expect(warnings.length).toBe(0);
  });

  it("empty root has no children", async () => {
    const loader = new MetaDataLoader({ freeze: false });
    const { root } = await loader.load([]);
    expect(root.ownChildren().length).toBe(0);
  });

  it("empty root round-trips cleanly (serialize → reload → equivalent)", async () => {
    const loader = new MetaDataLoader({ freeze: false });
    const { root } = await loader.load([]);
    const reparsed = await roundTrip(root);
    assertModelsEqual(root, reparsed);
  });
});

// ===========================================================================
// 5. Per-fixture entity counts (ground truth from Java canonical fixtures)
// ===========================================================================

describe("Entity counts: fruitbasket-metadata.json", () => {
  // 2 abstract fields (common::id, common::name) + 5 objects (Basket, Fruit, Apple, Macintosh, Orange)
  it("has 7 top-level children", async () => {
    const { root } = await loadFixture("fruitbasket-metadata.json");
    expect(root.ownChildren().length).toBe(7);
  });

  it("has 2 abstract field children", async () => {
    const { root } = await loadFixture("fruitbasket-metadata.json");
    const abstractFields = root.ownChildrenOfType(TYPE_FIELD);
    expect(abstractFields.length).toBe(2);
  });

  it("has 5 object children", async () => {
    const { root } = await loadFixture("fruitbasket-metadata.json");
    const objects = root.ownChildrenOfType(TYPE_OBJECT);
    expect(objects.length).toBe(5);
  });

  it("object names are Basket, Fruit, Apple, Macintosh, Orange", async () => {
    const { root } = await loadFixture("fruitbasket-metadata.json");
    const objects = root.ownChildrenOfType(TYPE_OBJECT);
    const names = objects.map((o) => o.name).sort();
    expect(names).toEqual(["Apple", "Basket", "Fruit", "Macintosh", "Orange"]);
  });
});

describe("Entity counts: fruitbasket-proxy-metadata.json", () => {
  // 2 abstract fields + 6 objects (Basket, BasketToFruit, Fruit, Apple, Macintosh, Orange)
  it("has 8 top-level children", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    expect(root.ownChildren().length).toBe(8);
  });

  it("has 2 abstract field children", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    const fields = root.ownChildrenOfType(TYPE_FIELD);
    expect(fields.length).toBe(2);
  });

  it("has 6 object children", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    const objects = root.ownChildrenOfType(TYPE_OBJECT);
    expect(objects.length).toBe(6);
  });

  it("object names are Basket, BasketToFruit, Fruit, Apple, Macintosh, Orange", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    const objects = root.ownChildrenOfType(TYPE_OBJECT);
    const names = objects.map((o) => o.name).sort();
    expect(names).toEqual(["Apple", "Basket", "BasketToFruit", "Fruit", "Macintosh", "Orange"]);
  });
});

describe("Entity counts: acme-common-metadata.json", () => {
  // 3 abstract fields: id, name, description
  it("has 3 top-level children", async () => {
    const { root } = await loadFixture("acme-common-metadata.json");
    expect(root.ownChildren().length).toBe(3);
  });

  it("all children are abstract fields", async () => {
    const { root } = await loadFixture("acme-common-metadata.json");
    const fields = root.ownChildrenOfType(TYPE_FIELD);
    expect(fields.length).toBe(3);
    expect(fields.every((f) => f.isAbstract)).toBe(true);
  });

  it("field names are id, name, description", async () => {
    const { root } = await loadFixture("acme-common-metadata.json");
    const fields = root.ownChildrenOfType(TYPE_FIELD);
    const names = fields.map((f) => f.name).sort();
    expect(names).toEqual(["description", "id", "name"]);
  });
});

describe("Entity counts: acme-vehicle-metadata.json (loaded after acme-common)", () => {
  // acme-common contributes 3 fields; acme-vehicle adds 6 objects = 9 total
  it("merged tree has 9 top-level children", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
    ]);
    expect(root.ownChildren().length).toBe(9);
  });

  it("has 3 abstract field children (from common)", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
    ]);
    const fields = root.ownChildrenOfType(TYPE_FIELD);
    expect(fields.length).toBe(3);
  });

  it("has 6 object children from vehicle file", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
    ]);
    const objects = root.ownChildrenOfType(TYPE_OBJECT);
    expect(objects.length).toBe(6);
  });

  it("vehicle object names are Garage, Vehicle, Car, Truck, Motorcycle, Porsche", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
    ]);
    const objects = root.ownChildrenOfType(TYPE_OBJECT);
    const names = objects.map((o) => o.name).sort();
    expect(names).toEqual(["Car", "Garage", "Motorcycle", "Porsche", "Truck", "Vehicle"]);
  });
});

describe("Entity counts: acme-vehicle-overlay-metadata.json (full stack)", () => {
  // Overlay adds fields to existing entities (Garage, Vehicle, Porsche, Motorcycle).
  // No new top-level entities — total stays at 9.
  it("merged tree still has 9 top-level children after overlay", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    expect(root.ownChildren().length).toBe(9);
  });
});

describe("Entity counts: valid-complete-metadata.json", () => {
  // 1 object: User
  it("has 1 top-level child", async () => {
    const { root } = await loadFixture("valid-complete-metadata.json");
    expect(root.ownChildren().length).toBe(1);
  });

  it("that child is an entity object named User with @javaRuntime=pojo", async () => {
    const { root } = await loadFixture("valid-complete-metadata.json");
    const user = root.ownChildByTypeAndName(TYPE_OBJECT, "User");
    expect(user).toBeDefined();
    expect(user!.subType).toBe("entity");
    expect(user!.attr("javaRuntime")).toBe("pojo");
  });
});

// ===========================================================================
// 6. Super resolution sanity (spot checks)
// ===========================================================================

describe("Super resolution sanity: fruitbasket-metadata.json", () => {
  it("Apple.superResolved points at Fruit", async () => {
    const { root } = await loadFixture("fruitbasket-metadata.json");
    const apple = root.ownChildByTypeAndName(TYPE_OBJECT, "Apple")!;
    expect(apple).toBeDefined();
    expect(apple.superRef).toBe("Fruit");
    expect(apple.superResolved).toBeDefined();
    expect(apple.superResolved!.name).toBe("Fruit");
  });

  it("Macintosh.superResolved points at Apple", async () => {
    const { root } = await loadFixture("fruitbasket-metadata.json");
    const macintosh = root.ownChildByTypeAndName(TYPE_OBJECT, "Macintosh")!;
    expect(macintosh).toBeDefined();
    expect(macintosh.superRef).toBe("Apple");
    expect(macintosh.superResolved).toBeDefined();
    expect(macintosh.superResolved!.name).toBe("Apple");
  });

  it("Orange.superResolved points at Fruit", async () => {
    const { root } = await loadFixture("fruitbasket-metadata.json");
    const orange = root.ownChildByTypeAndName(TYPE_OBJECT, "Orange")!;
    expect(orange).toBeDefined();
    expect(orange.superResolved).toBeDefined();
    expect(orange.superResolved!.name).toBe("Fruit");
  });

  it("Fruit object is abstract", async () => {
    const { root } = await loadFixture("fruitbasket-metadata.json");
    const fruit = root.ownChildByTypeAndName(TYPE_OBJECT, "Fruit")!;
    expect(fruit).toBeDefined();
    expect(fruit.isAbstract).toBe(true);
  });
});

describe("Super resolution sanity: fruitbasket-proxy-metadata.json", () => {
  it("Apple.superResolved points at Fruit (proxy variant)", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    const apple = root.ownChildByTypeAndName(TYPE_OBJECT, "Apple")!;
    expect(apple).toBeDefined();
    expect(apple.superResolved).toBeDefined();
    expect(apple.superResolved!.name).toBe("Fruit");
  });

  it("Macintosh.superResolved points at Apple (proxy variant)", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    const macintosh = root.ownChildByTypeAndName(TYPE_OBJECT, "Macintosh")!;
    expect(macintosh).toBeDefined();
    expect(macintosh.superResolved).toBeDefined();
    expect(macintosh.superResolved!.name).toBe("Apple");
  });
});

describe("Super resolution sanity: acme-vehicle-metadata.json (common + vehicle)", () => {
  it("Car.superResolved points at Vehicle", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
    ]);
    const car = root.ownChildByTypeAndName(TYPE_OBJECT, "Car")!;
    expect(car).toBeDefined();
    expect(car.superRef).toBe("..::Vehicle");
    expect(car.superResolved).toBeDefined();
    expect(car.superResolved!.name).toBe("Vehicle");
  });

  it("Porsche.superResolved points at Car", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
    ]);
    const porsche = root.ownChildByTypeAndName(TYPE_OBJECT, "Porsche")!;
    expect(porsche).toBeDefined();
    expect(porsche.superRef).toBe("..::Car");
    expect(porsche.superResolved).toBeDefined();
    expect(porsche.superResolved!.name).toBe("Car");
  });

  it("Vehicle is abstract", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
    ]);
    const vehicle = root.ownChildByTypeAndName(TYPE_OBJECT, "Vehicle")!;
    expect(vehicle).toBeDefined();
    expect(vehicle.isAbstract).toBe(true);
  });
});

// ===========================================================================
// 7. Merge application sanity (spot checks)
// ===========================================================================

describe("Merge application sanity: acme-vehicle overlay", () => {
  // The overlay file uses merge: true on Garage, Vehicle, Porsche, Motorcycle.
  // merge adds new fields to the existing entity — does not replace it.

  it("Garage has premiumLocation field from overlay (not present in base vehicle file)", async () => {
    // First confirm it's NOT there with just vehicle (no overlay)
    const { root: withoutOverlay } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
    ]);
    const garage = withoutOverlay.ownChildByTypeAndName(TYPE_OBJECT, "Garage")!;
    expect(garage.ownChildByTypeAndName(TYPE_FIELD, "premiumLocation")).toBeUndefined();

    // Then confirm it IS there with overlay applied
    const { root: withOverlay } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    const garageWithOverlay = withOverlay.ownChildByTypeAndName(TYPE_OBJECT, "Garage")!;
    expect(garageWithOverlay.ownChildByTypeAndName(TYPE_FIELD, "premiumLocation")).toBeDefined();
  });

  it("Vehicle has warranty and inspectionDate fields from overlay", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    const vehicle = root.ownChildByTypeAndName(TYPE_OBJECT, "Vehicle")!;
    expect(vehicle.ownChildByTypeAndName(TYPE_FIELD, "warranty")).toBeDefined();
    expect(vehicle.ownChildByTypeAndName(TYPE_FIELD, "inspectionDate")).toBeDefined();
  });

  it("Porsche retains its original fields AND gains certifiedPreOwned from overlay", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    const porsche = root.ownChildByTypeAndName(TYPE_OBJECT, "Porsche")!;
    // Original fields from vehicle file
    expect(porsche.ownChildByTypeAndName(TYPE_FIELD, "model")).toBeDefined();
    expect(porsche.ownChildByTypeAndName(TYPE_FIELD, "topSpeed")).toBeDefined();
    expect(porsche.ownChildByTypeAndName(TYPE_FIELD, "series")).toBeDefined();
    // New field from overlay
    expect(porsche.ownChildByTypeAndName(TYPE_FIELD, "certifiedPreOwned")).toBeDefined();
  });

  it("Motorcycle retains its original fields AND gains customPaint from overlay", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    const motorcycle = root.ownChildByTypeAndName(TYPE_OBJECT, "Motorcycle")!;
    // Original fields
    expect(motorcycle.ownChildByTypeAndName(TYPE_FIELD, "engineSize")).toBeDefined();
    expect(motorcycle.ownChildByTypeAndName(TYPE_FIELD, "bikeType")).toBeDefined();
    // New field from overlay
    expect(motorcycle.ownChildByTypeAndName(TYPE_FIELD, "customPaint")).toBeDefined();
  });

  it("isMerge is set to true on entities touched by the overlay file", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    // Garage, Vehicle, Porsche, Motorcycle all use merge: true in the overlay file
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Garage")!.isMerge).toBe(true);
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Vehicle")!.isMerge).toBe(true);
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Porsche")!.isMerge).toBe(true);
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Motorcycle")!.isMerge).toBe(true);
  });

  it("Car and Truck (not in overlay) do NOT have isMerge set", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Car")!.isMerge).toBe(false);
    expect(root.ownChildByTypeAndName(TYPE_OBJECT, "Truck")!.isMerge).toBe(false);
  });

  it("round-trips correctly (override attrs preserved after serialize → reload)", async () => {
    const { root } = await loadFixtures([
      "acme-common-metadata.json",
      "acme-vehicle-metadata.json",
      "acme-vehicle-overlay-metadata.json",
    ]);
    // Verify override-added fields survive round-trip
    const reparsed = await roundTrip(root);
    const garageReparsed = reparsed.ownChildByTypeAndName(TYPE_OBJECT, "Garage")!;
    expect(garageReparsed.ownChildByTypeAndName(TYPE_FIELD, "premiumLocation")).toBeDefined();
    const vehicleReparsed = reparsed.ownChildByTypeAndName(TYPE_OBJECT, "Vehicle")!;
    expect(vehicleReparsed.ownChildByTypeAndName(TYPE_FIELD, "warranty")).toBeDefined();
  });
});

// ===========================================================================
// Additional round-trip sanity: fruitbasket proxy-specific features
// ===========================================================================

describe("Fruitbasket proxy: identity nodes and @fields arrays round-trip", () => {
  it("Basket has an identity child of type primary", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    const basket = root.ownChildByTypeAndName(TYPE_OBJECT, "Basket")!;
    expect(basket).toBeDefined();
    const identity = basket.ownChildByTypeAndName(TYPE_IDENTITY, "primary");
    expect(identity).toBeDefined();
    expect(identity!.subType).toBe("primary");
  });

  it("identity @fields array attr survives round-trip", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    const basket = root.ownChildByTypeAndName(TYPE_OBJECT, "Basket")!;
    const identity = basket.ownChildByTypeAndName(TYPE_IDENTITY, "primary")!;
    // @fields is a stringarray attr
    const fields = identity.attr("fields");
    expect(Array.isArray(fields)).toBe(true);
    expect(fields).toEqual(["id"]);

    // Verify it survives round-trip
    const reparsed = await roundTrip(root);
    const reparsedBasket = reparsed.ownChildByTypeAndName(TYPE_OBJECT, "Basket")!;
    const reparsedIdentity = reparsedBasket.ownChildByTypeAndName(TYPE_IDENTITY, "primary")!;
    const reparsedFields = reparsedIdentity.attr("fields");
    expect(reparsedFields).toEqual(["id"]);
  });

  it("@generation attr survives round-trip", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    const basket = root.ownChildByTypeAndName(TYPE_OBJECT, "Basket")!;
    const identity = basket.ownChildByTypeAndName(TYPE_IDENTITY, "primary")!;
    expect(identity.attr("generation")).toBe("increment");

    const reparsed = await roundTrip(root);
    const reparsedBasket = reparsed.ownChildByTypeAndName(TYPE_OBJECT, "Basket")!;
    const reparsedIdentity = reparsedBasket.ownChildByTypeAndName(TYPE_IDENTITY, "primary")!;
    expect(reparsedIdentity.attr("generation")).toBe("increment");
  });

  it("BasketToFruit has relationship children that round-trip correctly", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    const btf = root.ownChildByTypeAndName(TYPE_OBJECT, "BasketToFruit")!;
    expect(btf).toBeDefined();
    const relationships = btf.ownChildrenOfType(TYPE_RELATIONSHIP);
    expect(relationships.length).toBe(2);

    const reparsed = await roundTrip(root);
    const reparsedBtf = reparsed.ownChildByTypeAndName(TYPE_OBJECT, "BasketToFruit")!;
    const reparsedRelationships = reparsedBtf.ownChildrenOfType(TYPE_RELATIONSHIP);
    expect(reparsedRelationships.length).toBe(2);
  });

  it("Basket, BasketToFruit, and Fruit are entity objects with @javaRuntime='proxy'", async () => {
    const { root } = await loadFixture("fruitbasket-proxy-metadata.json");
    // Basket, BasketToFruit, Fruit are explicitly `entity` with @javaRuntime: "proxy"
    // (v0.3 rework — runtime strategy moved out of subType).
    // Apple, Macintosh, Orange have no explicit subType, so parser defaults to "base".
    for (const name of ["Basket", "BasketToFruit", "Fruit"]) {
      const obj = root.ownChildByTypeAndName(TYPE_OBJECT, name)!;
      expect(obj).toBeDefined();
      expect(obj.subType).toBe(OBJECT_SUBTYPE_ENTITY);
      expect(obj.attr("javaRuntime")).toBe("proxy");
    }
  });
});

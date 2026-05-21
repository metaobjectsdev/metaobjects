import { describe, test, expect } from "bun:test";
import {
  ObjectManager,
  RuntimeError, ValidationError, NotFoundError, ConstraintViolationError,
  MetadataError, UnsafeNameError,
  type Dialect,
} from "../src/index.js";
import { inMemoryDriver, kyselyDriver } from "../src/drivers/index.js";

describe("Public API surface", () => {
  test("all runtime exports are defined", () => {
    expect(ObjectManager).toBeDefined();
    expect(RuntimeError).toBeDefined();
    expect(ValidationError).toBeDefined();
    expect(NotFoundError).toBeDefined();
    expect(ConstraintViolationError).toBeDefined();
    expect(MetadataError).toBeDefined();
    expect(UnsafeNameError).toBeDefined();
  });

  test("drivers subpath exports both drivers", () => {
    expect(inMemoryDriver).toBeDefined();
    expect(kyselyDriver).toBeDefined();
  });

  test("Dialect type accepts the three values", () => {
    const a: Dialect = "sqlite";
    const b: Dialect = "postgres";
    const c: Dialect = "memory";
    expect([a, b, c]).toEqual(["sqlite", "postgres", "memory"]);
  });
});

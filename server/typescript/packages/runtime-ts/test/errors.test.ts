import { describe, test, expect } from "bun:test";
import {
  RuntimeError,
  ValidationError,
  NotFoundError,
  ConstraintViolationError,
  MetadataError,
  UnsafeNameError,
  type ValidationFailure,
} from "../src/errors.js";

describe("RuntimeError base", () => {
  test("carries code + entity + cause", () => {
    const cause = new Error("inner");
    const err = new RuntimeError("boom", { code: "demo_code", entity: "Post", cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("demo_code");
    expect(err.entity).toBe("Post");
    expect(err.cause).toBe(cause);
    expect(err.message).toBe("boom");
  });

  test("entity + cause are optional", () => {
    const err = new RuntimeError("plain", { code: "x" });
    expect(err.entity).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});

describe("ValidationError", () => {
  test("carries errors[]", () => {
    const failures: ValidationFailure[] = [
      { field: "title", rule: "required", message: "title is required" },
    ];
    const err = new ValidationError("Post is invalid", { entity: "Post", errors: failures });
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err.code).toBe("validation_failed");
    expect(err.errors).toEqual(failures);
    expect(err.entity).toBe("Post");
  });
});

describe("NotFoundError", () => {
  test("carries id", () => {
    const err = new NotFoundError("Post 42 not found", { entity: "Post", id: 42 });
    expect(err.code).toBe("not_found");
    expect(err.id).toBe(42);
  });
});

describe("ConstraintViolationError", () => {
  test("carries kind + table + optional field/detail", () => {
    const err = new ConstraintViolationError("unique violation", {
      kind: "unique", table: "users", field: "email", detail: "email already in use",
    });
    expect(err.code).toBe("constraint_violation");
    expect(err.kind).toBe("unique");
    expect(err.table).toBe("users");
    expect(err.field).toBe("email");
    expect(err.detail).toBe("email already in use");
  });
});

describe("MetadataError", () => {
  test("plain code", () => {
    const err = new MetadataError("Unknown entity 'Foo'");
    expect(err.code).toBe("metadata_error");
    expect(err.message).toBe("Unknown entity 'Foo'");
  });
});

describe("UnsafeNameError", () => {
  test("carries the rejected value", () => {
    const err = new UnsafeNameError("Unsafe entity name '../evil'", { value: "../evil" });
    expect(err.code).toBe("unsafe_name");
    expect(err.value).toBe("../evil");
  });
});

describe("JSON serialization", () => {
  test("error fields survive JSON.stringify when toJSON is provided", () => {
    const err = new ValidationError("x", {
      entity: "Post",
      errors: [{ field: "title", rule: "required", message: "..." }],
    });
    const json = JSON.parse(JSON.stringify(err));
    expect(json.code).toBe("validation_failed");
    expect(json.entity).toBe("Post");
    expect(json.errors).toHaveLength(1);
  });
});

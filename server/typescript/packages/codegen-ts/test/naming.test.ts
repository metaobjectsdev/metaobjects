import { describe, test, expect } from "bun:test";
import {
  toSnakeCase,
  toCamelCase,
  pluralize,
  tableNameFromEntity,
  columnNameFromField,
  variableNameFromEntity,
} from "../src/naming.js";

describe("toSnakeCase", () => {
  test("converts PascalCase", () => {
    expect(toSnakeCase("UserAccount")).toBe("user_account");
  });
  test("converts camelCase", () => {
    expect(toSnakeCase("firstName")).toBe("first_name");
  });
  test("preserves all-lowercase", () => {
    expect(toSnakeCase("name")).toBe("name");
  });
  test("handles consecutive caps as one word", () => {
    expect(toSnakeCase("APIKey")).toBe("api_key");
  });
});

describe("toCamelCase", () => {
  test("converts snake_case", () => {
    expect(toCamelCase("user_account")).toBe("userAccount");
  });
  test("preserves camelCase", () => {
    expect(toCamelCase("firstName")).toBe("firstName");
  });
});

describe("pluralize", () => {
  test("appends 's' to most words", () => {
    expect(pluralize("user")).toBe("users");
    expect(pluralize("post")).toBe("posts");
  });
  test("handles words ending in y", () => {
    expect(pluralize("category")).toBe("categories");
  });
  test("handles words ending in s, x, z, ch, sh", () => {
    expect(pluralize("box")).toBe("boxes");
    expect(pluralize("class")).toBe("classes");
  });
  test("preserves explicit @dbTable name (handled by caller, not here)", () => {
    // Just confirms pluralize doesn't crash on weird input
    expect(pluralize("Person")).toBe("Persons"); // documented imperfection per design §13 #1
  });
});

describe("tableNameFromEntity", () => {
  test("snake_case + plural", () => {
    expect(tableNameFromEntity("Post")).toBe("posts");
    expect(tableNameFromEntity("UserAccount")).toBe("user_accounts");
    expect(tableNameFromEntity("Category")).toBe("categories");
  });
});

describe("columnNameFromField", () => {
  test("snake_case", () => {
    expect(columnNameFromField("firstName")).toBe("first_name");
    expect(columnNameFromField("id")).toBe("id");
  });
});

describe("variableNameFromEntity", () => {
  test("camelCase + plural", () => {
    expect(variableNameFromEntity("Post")).toBe("posts");
    expect(variableNameFromEntity("UserAccount")).toBe("userAccounts");
    expect(variableNameFromEntity("Category")).toBe("categories");
  });
});

import { stripPackage } from "@metaobjects/metadata";

describe("stripPackage", () => {
  test("strips package prefix from fully-qualified name", () => {
    expect(stripPackage("trainerWebsite::Program")).toBe("Program");
  });
  test("strips nested package prefix", () => {
    expect(stripPackage("acme::common::User")).toBe("User");
  });
  test("returns unchanged when no package separator present", () => {
    expect(stripPackage("Program")).toBe("Program");
  });
  test("returns empty string when input ends with separator", () => {
    expect(stripPackage("acme::")).toBe("");
  });
});

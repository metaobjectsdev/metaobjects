// test/runner/checksum.test.ts
import { test, expect, describe } from "bun:test";
import { contentChecksum } from "../../src/runner/checksum.js";

describe("contentChecksum", () => {
  test("is stable for identical content", () => {
    expect(contentChecksum("CREATE TABLE a();")).toBe(contentChecksum("CREATE TABLE a();"));
  });
  test("ignores trailing whitespace, CRLF, and leading/trailing blank lines", () => {
    const a = "CREATE TABLE a();\nCREATE TABLE b();";
    const b = "\r\n  \nCREATE TABLE a();   \r\nCREATE TABLE b();\t\n\n";
    expect(contentChecksum(b)).toBe(contentChecksum(a));
  });
  test("differs when meaningful content differs", () => {
    expect(contentChecksum("CREATE TABLE a();")).not.toBe(contentChecksum("CREATE TABLE b();"));
  });
});

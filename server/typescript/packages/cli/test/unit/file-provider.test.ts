import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileProvider } from "../../src/lib/file-provider.js";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function dir(): string {
  tmp = mkdtempSync(join(tmpdir(), "metaobjects-fileprovider-"));
  mkdirSync(join(tmp, "group"), { recursive: true });
  return tmp;
}

describe("FileProvider — maps group/source to a file under the base dir", () => {
  test("resolves a .mustache file", () => {
    const base = dir();
    writeFileSync(join(base, "group", "source.mustache"), "hi {{x}}", "utf8");
    expect(new FileProvider(base).resolve("group/source")).toBe("hi {{x}}");
  });

  test("falls back to a .txt extension", () => {
    const base = dir();
    writeFileSync(join(base, "group", "source.txt"), "plain", "utf8");
    expect(new FileProvider(base).resolve("group/source")).toBe("plain");
  });

  test("returns undefined when nothing matches", () => {
    expect(new FileProvider(dir()).resolve("group/missing")).toBeUndefined();
  });
});

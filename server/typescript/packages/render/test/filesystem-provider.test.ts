import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemProvider, InMemoryProvider } from "../src/providers.js";
import { render } from "../src/index.js";

// The filesystem provider mirrors the C# / Java / Python FilesystemProvider:
// `group/source` → <root>/group/source.mustache, undefined when absent, and a ref
// that escapes the root is refused (undefined, never a throw).
describe("FilesystemProvider", () => {
  let parent: string;
  let root: string;

  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), "mo-fsprov-"));
    root = join(parent, "prompts");
    mkdirSync(join(root, "lobby"), { recursive: true });
    writeFileSync(join(root, "lobby", "welcome.mustache"), "Welcome, {{name}}!");
    writeFileSync(join(root, "lobby", "notes.txt"), "plain {{name}}");
    mkdirSync(join(root, "lobby", "dir.mustache"));
    writeFileSync(join(parent, "secret.mustache"), "outside the root");
  });

  afterAll(() => rmSync(parent, { recursive: true, force: true }));

  test("resolves group/source to <root>/group/source.mustache", () => {
    expect(new FilesystemProvider(root).resolve("lobby/welcome")).toBe("Welcome, {{name}}!");
  });

  test("returns undefined for a missing template", () => {
    expect(new FilesystemProvider(root).resolve("lobby/absent")).toBeUndefined();
  });

  test("returns undefined for an empty ref", () => {
    expect(new FilesystemProvider(root).resolve("")).toBeUndefined();
    expect(new FilesystemProvider(root).resolve("/")).toBeUndefined();
  });

  test("returns undefined when the candidate is a directory", () => {
    expect(new FilesystemProvider(root).resolve("lobby/dir")).toBeUndefined();
  });

  test("refuses a ref that escapes the root", () => {
    expect(new FilesystemProvider(root).resolve("../secret")).toBeUndefined();
    expect(new FilesystemProvider(root).resolve("lobby/../../secret")).toBeUndefined();
  });

  test("honours a custom extension", () => {
    expect(new FilesystemProvider(root, ".txt").resolve("lobby/notes")).toBe("plain {{name}}");
  });

  test("drives render() by ref", () => {
    const out = render({ ref: "lobby/welcome", payload: { name: "Ada" }, provider: new FilesystemProvider(root) });
    expect(out).toBe("Welcome, Ada!");
  });

  test("the providers entry also re-exports InMemoryProvider", () => {
    expect(new InMemoryProvider({ "a/b": "x" }).resolve("a/b")).toBe("x");
  });
});

// The root entry is imported by browser bundles, so it must never pull in a
// Node built-in. Only the `./providers` subpath may touch the filesystem.
describe("root entry stays browser-safe", () => {
  const srcDir = join(import.meta.dir, "..", "src");
  const NODE_ONLY = new Set(["filesystem-provider.ts", "providers.ts"]);

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }

  test("no module outside the providers subpath imports node:*", () => {
    const offenders = walk(srcDir)
      .filter((p) => p.endsWith(".ts") && !NODE_ONLY.has(p.slice(srcDir.length + 1)))
      .filter((p) => /from\s+["']node:/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("package.json exports a ./providers subpath", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(pkg.exports["./providers"]).toEqual({
      bun: "./src/providers.ts",
      types: "./dist/providers.d.ts",
      default: "./dist/providers.js",
    });
  });
});

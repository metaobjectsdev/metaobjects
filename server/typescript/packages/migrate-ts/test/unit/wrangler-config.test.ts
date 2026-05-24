import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWranglerConfig, parseWranglerConfig, resolveD1Binding } from "../../src/wrangler-config.js";

describe("wrangler-config", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wrangler-cfg-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("findWranglerConfig: prefers wrangler.toml in cwd", () => {
    writeFileSync(join(dir, "wrangler.toml"), `name = "x"\n`);
    expect(findWranglerConfig(dir)).toBe(join(dir, "wrangler.toml"));
  });

  test("findWranglerConfig: falls back to wrangler.jsonc", () => {
    writeFileSync(join(dir, "wrangler.jsonc"), `{ "name": "x" }`);
    expect(findWranglerConfig(dir)).toBe(join(dir, "wrangler.jsonc"));
  });

  test("findWranglerConfig: walks up the parent tree", () => {
    const sub = join(dir, "a", "b", "c");
    require("node:fs").mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, "wrangler.toml"), `name = "x"\n`);
    expect(findWranglerConfig(sub)).toBe(join(dir, "wrangler.toml"));
  });

  test("findWranglerConfig: returns undefined when nothing found", () => {
    expect(findWranglerConfig(dir)).toBeUndefined();
  });

  test("parseWranglerConfig: extracts d1 bindings from TOML", () => {
    const path = join(dir, "wrangler.toml");
    writeFileSync(path, [
      `name = "myapp"`,
      ``,
      `[[d1_databases]]`,
      `binding = "DB"`,
      `database_name = "myapp-prod"`,
      `database_id = "abc-123"`,
      `migrations_dir = "db/migrations"`,
      ``,
      `[[d1_databases]]`,
      `binding = "CACHE"`,
      `database_name = "myapp-cache"`,
      `database_id = "def-456"`,
    ].join("\n"));
    const parsed = parseWranglerConfig(path);
    expect(parsed.d1Bindings).toEqual([
      { binding: "DB", database_name: "myapp-prod", database_id: "abc-123", migrations_dir: "db/migrations" },
      { binding: "CACHE", database_name: "myapp-cache", database_id: "def-456", migrations_dir: undefined },
    ]);
  });

  test("parseWranglerConfig: returns empty bindings when no d1 block", () => {
    const path = join(dir, "wrangler.toml");
    writeFileSync(path, `name = "x"\n`);
    expect(parseWranglerConfig(path).d1Bindings).toEqual([]);
  });

  test("parseWranglerConfig: handles jsonc with comments", () => {
    const path = join(dir, "wrangler.jsonc");
    writeFileSync(path, [
      `{`,
      `  // top-level binding`,
      `  "name": "x",`,
      `  "d1_databases": [`,
      `    { "binding": "DB", "database_name": "x-prod", "database_id": "id1" }`,
      `  ]`,
      `}`,
    ].join("\n"));
    const parsed = parseWranglerConfig(path);
    expect(parsed.d1Bindings).toEqual([
      { binding: "DB", database_name: "x-prod", database_id: "id1", migrations_dir: undefined },
    ]);
  });

  test("resolveD1Binding: returns the only binding when there's exactly one and no explicit name", () => {
    const bindings = [{ binding: "DB", database_name: "x", database_id: "id1", migrations_dir: undefined }];
    expect(resolveD1Binding(bindings, undefined)).toEqual(bindings[0]);
  });

  test("resolveD1Binding: returns the explicitly named binding", () => {
    const bindings = [
      { binding: "DB", database_name: "x", database_id: "id1", migrations_dir: undefined },
      { binding: "CACHE", database_name: "y", database_id: "id2", migrations_dir: undefined },
    ];
    expect(resolveD1Binding(bindings, "CACHE")).toEqual(bindings[1]);
  });

  test("resolveD1Binding: throws when multiple bindings and no explicit name", () => {
    const bindings = [
      { binding: "DB", database_name: "x", database_id: "id1", migrations_dir: undefined },
      { binding: "CACHE", database_name: "y", database_id: "id2", migrations_dir: undefined },
    ];
    expect(() => resolveD1Binding(bindings, undefined)).toThrow(/multiple d1 bindings/i);
  });

  test("resolveD1Binding: throws with binding list when explicit name is unknown", () => {
    const bindings = [{ binding: "DB", database_name: "x", database_id: "id1", migrations_dir: undefined }];
    expect(() => resolveD1Binding(bindings, "MISSING")).toThrow(/MISSING.*DB/);
  });

  test("resolveD1Binding: throws when there are no bindings at all", () => {
    expect(() => resolveD1Binding([], undefined)).toThrow(/no d1 bindings/i);
  });
});

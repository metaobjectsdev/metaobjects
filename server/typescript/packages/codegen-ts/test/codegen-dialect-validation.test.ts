// An unknown codegen `dialect` used to fall through to the Postgres branch of every dialect
// switch and emit `pgTable` code, silently. `"d1"` is the common case: it is a `meta migrate`
// transport, and D1 codegen is `"sqlite"`. Both choke points (normalizeConfig, runGen) refuse it.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen } from "../src/runner.js";
import { normalizeConfig, assertCodegenDialect, CODEGEN_DIALECTS, type MetaobjectsGenConfig } from "../src/metaobjects-config.js";

const base = { outDir: "gen", generators: [] } as unknown as MetaobjectsGenConfig;

describe("assertCodegenDialect", () => {
  test("accepts every valid dialect and undefined", () => {
    for (const d of CODEGEN_DIALECTS) expect(() => assertCodegenDialect(d)).not.toThrow();
    expect(() => assertCodegenDialect(undefined)).not.toThrow();
    expect([...CODEGEN_DIALECTS]).toEqual(["sqlite", "postgres", "mysql"]);
  });

  test('"d1" is refused with the sqlite instruction and the reason', () => {
    expect(() => assertCodegenDialect("d1")).toThrow(
      /invalid codegen dialect "d1".*expected one of: "sqlite", "postgres", "mysql".*Cloudflare D1 is SQLite: set `dialect: "sqlite"`.*meta migrate/s,
    );
  });

  test("any other unknown value names the valid values, without the D1 hint", () => {
    let message = "";
    try { assertCodegenDialect("postgress"); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('invalid codegen dialect "postgress"');
    expect(message).toContain('"sqlite", "postgres", "mysql"');
    expect(message).not.toContain("D1");
  });

  test("a non-string value is refused too", () => {
    expect(() => assertCodegenDialect(5)).toThrow(/invalid codegen dialect 5/);
  });
});

describe("normalizeConfig", () => {
  test('rejects dialect "d1" instead of defaulting it through to Postgres', () => {
    expect(() => normalizeConfig({ ...base, dialect: "d1" } as unknown as MetaobjectsGenConfig)).toThrow(/Cloudflare D1 is SQLite/);
  });
  test("keeps valid and omitted dialects", () => {
    expect(normalizeConfig({ ...base, dialect: "mysql" }).dialect).toBe("mysql");
    expect(normalizeConfig({ ...base }).dialect).toBe("sqlite");
  });
});

describe("runGen", () => {
  test('refuses dialect "d1" for a project with a sourced object, before writing anything', async () => {
    const tmp = mkdtempSync(join(tmpdir(), "codegen-dialect-"));
    try {
      const json = JSON.stringify({ "metadata.root": { package: "app", children: [
        { "object.entity": { name: "Note", children: [
          { "field.string": { name: "title" } },
          { "source.rdb": { "@table": "notes" } },
        ] } },
      ] } });
      const { root } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
      await expect(
        runGen({ metadata: root, projectRoot: tmp, config: { ...base, outDir: "gen", dialect: "d1" } as unknown as MetaobjectsGenConfig }),
      ).rejects.toThrow(/invalid codegen dialect "d1"/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

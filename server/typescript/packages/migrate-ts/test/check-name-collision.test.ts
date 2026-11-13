// rc.21 fix round (I2): two different CHECKs under one default name are refused at build, naming
// both, instead of a CREATE TABLE the database refuses ("constraint already exists").
// rc.21 part B (N1): only where the database requires unique names. SQLite and D1 accept and
// enforce two CHECKs under one name, so they keep both, and the CHECK diff converges on them.
// rc.21 part B (N2): a qualified default name is fitted to Postgres's 63-byte identifier limit.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, fitPgIdentifier } from "../src/expected-schema.js";
import { diff } from "../src/diff/index.js";
import { emit } from "../src/emit/index.js";
import { introspect } from "../src/introspect/index.js";

const WINDOW = JSON.stringify({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Window", children: [
    { "source.rdb": { "@table": "windows" } },
    { "field.long": { name: "id" } },
    { "field.int": { name: "a" } }, { "field.int": { name: "b" } }, { "field.int": { name: "c" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "validator.comparison": { name: "ab", "@left": "a", "@op": "lt", "@right": "b" } },
    { "validator.comparison": { name: "ac", "@left": "a", "@op": "lt", "@right": "c" } } ] } } ] } });

async function load(json: string) {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  return root;
}

test("two CHECKs under one default name are refused on Postgres", async () => {
  const root = await load(WINDOW);
  expect(() => buildExpectedSchema(root, { dialect: "postgres" })).toThrow(/both named 'windows_a_cmp_chk'.*Postgres requires/);
});

test("SQLite and D1 keep both CHECKs under the one name", async () => {
  const root = await load(WINDOW);
  for (const dialect of ["sqlite", "d1"] as const) {
    const windows = buildExpectedSchema(root, { dialect }).tables.find((t) => t.name === "windows")!;
    expect(windows.checks.filter((c) => c.name === "windows_a_cmp_chk").map((c) => c.expression))
      .toEqual(['"a" < "b"', '"a" < "c"']);
  }
});

test("SQLite: a table holding both same-named CHECKs migrates once and then shows no change", async () => {
  const root = await load(WINDOW);
  const dir = mkdtempSync(join(tmpdir(), "migrate-ts-dup-check-"));
  const k = new Kysely<Record<string, unknown>>({ dialect: new LibsqlDialect({ url: `file:${join(dir, "t.db")}` }) });
  try {
    const expected = buildExpectedSchema(root, { dialect: "sqlite" });
    const { up } = emit((await diff(expected, await introspect(k, "sqlite"), { dialect: "sqlite" })).changes, { dialect: "sqlite", expectedSchema: expected });
    for (const stmt of up.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) await sql.raw(stmt).execute(k);
    // Both rules hold.
    await sql.raw("INSERT INTO windows (id, a, b, c) VALUES (1, 1, 2, 3)").execute(k);
    await expect(sql.raw("INSERT INTO windows (id, a, b, c) VALUES (2, 1, 9, 0)").execute(k)).rejects.toThrow(/CHECK/);
    await expect(sql.raw("INSERT INTO windows (id, a, b, c) VALUES (3, 1, 0, 9)").execute(k)).rejects.toThrow(/CHECK/);
    const again = await diff(expected, await introspect(k, "sqlite"), { dialect: "sqlite" });
    expect(again.changes.filter((c) => c.kind === "add-check" || c.kind === "drop-check")).toEqual([]);
  } finally {
    await k.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fitPgIdentifier keeps a name that fits and shortens a longer one to 63 bytes, deterministically", () => {
  expect(fitPgIdentifier("devices_meter_serial_chk")).toBe("devices_meter_serial_chk");
  const long = `${"x".repeat(40)}_${"y".repeat(30)}_chk`;
  const fitted = fitPgIdentifier(long);
  expect(Buffer.byteLength(fitted)).toBe(63);
  expect(fitted.startsWith("x".repeat(40) + "_" + "y".repeat(13))).toBe(true);
  expect(fitted).toMatch(/_[0-9a-f]{8}$/);
  expect(fitPgIdentifier(long)).toBe(fitted);
  // Two long names sharing their first 54 bytes stay apart.
  expect(fitPgIdentifier(long.replace("_chk", "_cmp"))).not.toBe(fitted);
  // Whole characters only: a multi-byte character is never split.
  const wide = "é".repeat(40);
  expect(Buffer.byteLength(fitPgIdentifier(wide))).toBeLessThanOrEqual(63);
  // The spelling every port pins (C#: CheckConstraintConformanceTests).
  expect(fitPgIdentifier("measurement_devices_with_a_rather_long_table_name_meterdevicekind_serial_chk"))
    .toBe("measurement_devices_with_a_rather_long_table_name_mete_559a7830");
  expect(fitPgIdentifier(wide)).toBe(`${"é".repeat(27)}_84fe2e03`);
});

test("a qualified TPH CHECK name over 63 bytes is fitted on Postgres and kept on SQLite", async () => {
  const table = "measurement_devices_with_a_rather_long_table_name";
  const root = await load(JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Device", "@discriminator": "kind", children: [
      { "source.rdb": { "@table": table } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "kind", "@maxLength": 20 } },
      { "identity.primary": { name: "id", "@fields": "id" } } ] } },
    { "object.entity": { name: "MeterDeviceKind", extends: "Device", "@discriminatorValue": "METER", children: [
      { "field.enum": { name: "serial", "@values": ["M1", "M2"] } } ] } },
    { "object.entity": { name: "SensorDeviceKind", extends: "Device", "@discriminatorValue": "SENSOR", children: [
      { "field.enum": { name: "serial", "@values": ["S1", "S2"] } } ] } },
  ] } }));
  const names = (dialect: "postgres" | "sqlite") =>
    buildExpectedSchema(root, { dialect }).tables.find((t) => t.name === table)!.checks
      .filter((c) => c.expression.includes('"serial"')).map((c) => c.name);
  const pg = names("postgres");
  expect(pg.length).toBe(2);
  for (const n of pg) expect(Buffer.byteLength(n)).toBe(63);
  expect(pg).toEqual([`${table}_meterdevicekind_serial_chk`, `${table}_sensordevicekind_serial_chk`].map(fitPgIdentifier));
  expect(new Set(pg).size).toBe(2);
  expect(names("sqlite")).toEqual([`${table}_meterdevicekind_serial_chk`, `${table}_sensordevicekind_serial_chk`]);
});

// The field.duration code a generated model module carries (templates/duration-wire-helper.ts):
// the Zod write helper and the Drizzle column codec. The EMITTED TEXT is transpiled and evaluated
// here against fixtures/duration-wire/vectors.json, so the vectors hold what an adopter runs, not
// a re-implementation of it.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DURATION_PATTERN } from "@metaobjectsdev/metadata";
import { DURATION_COLUMN_FN } from "../src/column-mapper.js";
import {
  DURATION_REGEX_LITERAL,
  DURATION_WRITE_HELPER_DECL,
  ZOD_DURATION_WRITE_EXPR,
  durationColumnDeclParts,
} from "../src/templates/duration-wire-helper.js";
import type { Dialect } from "../src/metaobjects-config.js";

interface Vectors {
  parse: Array<{ in: string; out: string }>;
  refused: string[];
  postgres: Array<{ in: string; out: string }>;
  postgresRefused: string[];
  postgresText: Array<{ in: string; out: string }>;
}
const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "duration-wire", "vectors.json"), "utf8"),
) as Vectors;

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** The write schema exactly as a generated module spells it: the helper declaration, then the expression. */
function writeSchema(): z.ZodType<string, z.ZodTypeDef, unknown> {
  const js = transpiler.transformSync(`${DURATION_WRITE_HELPER_DECL}\nexport const schema = ${ZOD_DURATION_WRITE_EXPR};`);
  const body = js.replace(/export const schema =/, "return");
  return new Function("z", body)(z) as z.ZodType<string, z.ZodTypeDef, unknown>;
}

interface Codec { dataType(): string; toDriver(v: string): string; fromDriver(v: unknown): string }

/** The column codec exactly as a generated module spells it; `customType` hands back its config. */
function columnCodec(dialect: Dialect): Codec {
  const [before, after] = durationColumnDeclParts(dialect);
  const js = transpiler.transformSync(`${before}customType${after}\nexport const codec = ${DURATION_COLUMN_FN};`);
  const body = js.replace(/export const codec =/, "return");
  return new Function("customType", body)((cfg: Codec) => cfg) as Codec;
}

describe("generated duration write schema", () => {
  const schema = writeSchema();

  test("the Zod regex is the metadata's accepted pattern", () => {
    expect(DURATION_REGEX_LITERAL).toBe(`/${DURATION_PATTERN}/`);
    expect(ZOD_DURATION_WRITE_EXPR).toBe(`z.string().regex(/${DURATION_PATTERN}/).transform(durationWrite)`);
  });
  for (const v of vectors.parse) {
    test(`parse ${v.in} -> ${v.out}`, () => {
      expect(schema.parse(v.in)).toBe(v.out);
    });
  }
  for (const v of vectors.refused) {
    test(`refused ${JSON.stringify(v)}`, () => {
      expect(schema.safeParse(v).success).toBe(false);
    });
  }
  test("the 256204778-hour bound: exactly at it is kept, one microsecond over is refused, and no value is formatted in exponent notation", () => {
    expect(schema.parse("PT256204778H")).toBe("PT256204778H");
    expect(schema.parse("-PT922337200800S")).toBe("-PT256204778H");
    expect(schema.parse("PT256204777H59M59.999999S")).toBe("PT256204777H59M59.999999S");
    for (const over of ["PT256204778H0.000001S", "-PT256204778H0.000001S", "PT922337200801S", "P99999999999999999999999D", "PT1" + "0".repeat(400) + "S"]) {
      const r = schema.safeParse(over);
      expect(r.success, over).toBe(false);
      expect(JSON.stringify(r.success ? "" : r.error.issues), over).toContain("256204778 hours");
    }
  });
  test("a non-string is refused", () => {
    expect(schema.safeParse(90).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });
});

describe("generated duration column codec", () => {
  const pg = columnCodec("postgres");
  const sqlite = columnCodec("sqlite");
  const mysql = columnCodec("mysql");

  test("the physical column type per dialect", () => {
    expect(pg.dataType()).toBe("interval");
    expect(sqlite.dataType()).toBe("text");
    expect(mysql.dataType()).toBe("varchar(64)");
  });

  for (const v of vectors.postgresText) {
    test(`Postgres binds ${v.in} as ${v.out}`, () => {
      expect(pg.toDriver(v.in)).toBe(v.out);
    });
  }
  for (const v of vectors.parse) {
    test(`SQLite / MySQL bind ${v.in} as ${v.out}; Postgres reads its own spelling back`, () => {
      expect(sqlite.toDriver(v.in)).toBe(v.out);
      expect(mysql.toDriver(v.in)).toBe(v.out);
      expect(pg.fromDriver(pg.toDriver(v.in))).toBe(v.out);
      expect(sqlite.fromDriver(v.in)).toBe(v.out);
    });
  }
  // The codec also takes the Postgres spelling, which runtime-ts binds a filter operand in; of the
  // refused ISO inputs only `1:30:00` is that spelling (one hour thirty), so it alone binds.
  for (const v of vectors.refused.filter((r) => r !== "1:30:00")) {
    test(`binding ${JSON.stringify(v)} throws`, () => {
      expect(() => pg.toDriver(v)).toThrow();
      expect(() => sqlite.toDriver(v)).toThrow();
    });
  }
  for (const v of vectors.postgresText) {
    test(`binding the Postgres spelling ${v.out} is the same span`, () => {
      expect(pg.toDriver(v.out)).toBe(v.out);
      expect(sqlite.toDriver(v.out)).toBe(v.in);
    });
  }
  for (const v of vectors.postgresRefused) {
    test(`binding ${v} throws (a year or month part, or not an interval)`, () => {
      expect(() => pg.toDriver(v)).toThrow();
    });
  }
  for (const v of vectors.postgres) {
    test(`Postgres text ${v.in} reads as ${v.out}`, () => {
      expect(pg.fromDriver(v.in)).toBe(v.out);
    });
  }
  for (const v of vectors.postgresRefused) {
    test(`Postgres text ${v} is refused on read`, () => {
      expect(() => pg.fromDriver(v)).toThrow();
    });
  }
  test("the codec holds the same bound on bind and on read", () => {
    expect(pg.toDriver("PT256204778H")).toBe("256204778:00:00");
    expect(pg.toDriver("-PT256204778H")).toBe("-256204778:00:00");
    expect(sqlite.toDriver("-P10675199DT2H")).toBe("-PT256204778H");
    for (const over of ["PT256204778H0.000001S", "P99999999999999999999999D", "256204778:00:00.000001", "10675199 days 02:00:01"]) {
      expect(() => pg.toDriver(over), over).toThrow(/256204778 hours/);
      expect(() => sqlite.toDriver(over), over).toThrow(/256204778 hours/);
      expect(() => pg.fromDriver(over), over).toThrow(/256204778 hours/);
    }
    expect(() => pg.fromDriver({ days: 10675200 })).toThrow(/256204778 hours/);
    // Mixed signs that net back inside the bound read fine.
    expect(pg.fromDriver("10675200 days -24:00:00")).toBe("PT256204776H");
  });
  test("a node-postgres interval object reads as the canonical form; a month part is refused", () => {
    expect(pg.fromDriver({ days: 1, hours: 2 })).toBe("PT26H");
    expect(pg.fromDriver({ minutes: -1, seconds: -30 })).toBe("-PT1M30S");
    expect(pg.fromDriver({ seconds: 1, milliseconds: 500.25 })).toBe("PT1.50025S");
    expect(() => pg.fromDriver({ months: 1 })).toThrow(/year or month/);
    expect(() => pg.fromDriver(42)).toThrow();
  });
});

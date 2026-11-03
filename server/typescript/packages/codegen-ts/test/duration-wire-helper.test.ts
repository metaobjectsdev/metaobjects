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
  storedMicros: Array<{ in: string; out: string }>;
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

interface Codec { dataType(): string; toDriver(v: string): string | number | bigint; fromDriver(v: unknown): string }

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
  test("no limit of its own: a span past every 64-bit or TimeSpan range is exact, never in exponent notation", () => {
    expect(schema.parse("PT256204779H")).toBe("PT256204779H");
    expect(schema.parse("P99999999999999999999999D")).toBe("PT2399999999999999999999976H");
    expect(schema.parse("PT1" + "0".repeat(40) + ".000001S")).toBe(
      "PT2777777777777777777777777777777777777H46M40.000001S",
    );
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

  test("the physical column type per dialect: interval; a 64-bit integer of microseconds elsewhere", () => {
    expect(pg.dataType()).toBe("interval");
    expect(sqlite.dataType()).toBe("integer");
    expect(mysql.dataType()).toBe("bigint");
  });

  for (const v of vectors.postgresText) {
    test(`Postgres binds ${v.in} as ${v.out}, and reads it back`, () => {
      expect(pg.toDriver(v.in)).toBe(v.out);
      expect(pg.fromDriver(v.out)).toBe(v.in);
    });
  }
  for (const v of vectors.storedMicros) {
    test(`SQLite / MySQL store ${v.in} as ${v.out} microseconds, and read it back`, () => {
      for (const codec of [sqlite, mysql]) {
        expect(String(codec.toDriver(v.in))).toBe(v.out);
        // A driver hands the integer back as a number, a bigint or a digit string.
        expect(codec.fromDriver(Number(v.out))).toBe(v.in);
        expect(codec.fromDriver(BigInt(v.out))).toBe(v.in);
        expect(codec.fromDriver(v.out)).toBe(v.in);
      }
    });
  }
  for (const v of vectors.parse) {
    test(`${v.in} round-trips as ${v.out} on every dialect`, () => {
      for (const codec of [pg, sqlite, mysql]) expect(codec.fromDriver(codec.toDriver(v.in))).toBe(v.out);
    });
  }
  test("a safe microsecond count binds as a number; past 2^53 as a bigint; past the 64-bit range it is refused", () => {
    expect(sqlite.toDriver("PT876000H")).toBe(3153600000000000);
    expect(sqlite.toDriver("PT2562047788H")).toBe(BigInt("9223372036800000000"));
    expect(sqlite.fromDriver(BigInt("9223372036800000000"))).toBe("PT2562047788H");
    expect(() => sqlite.toDriver("PT2562047789H")).toThrow(/64-bit/);
    expect(() => mysql.toDriver("-PT2562047789H")).toThrow(/64-bit/);
    // Postgres has no such limit in the codec: its interval range is Postgres's to enforce.
    expect(pg.toDriver("PT2562047789H")).toBe("2562047789:00:00");
  });
  test("runtime-ts's filter operands bind through the codec unchanged: the micros on SQLite / MySQL, the interval text on Postgres", () => {
    expect(sqlite.toDriver(5400000000 as never)).toBe(5400000000);
    expect(mysql.toDriver(BigInt("-90000000") as never)).toBe(-90000000);
    expect(pg.toDriver("01:30:00")).toBe("01:30:00");
  });
  for (const v of vectors.refused) {
    test(`binding ${JSON.stringify(v)} throws`, () => {
      // The codec takes the Postgres spelling too (runtime-ts binds a Postgres operand in it), and
      // `1:30:00` is that spelling — one hour thirty — so on Postgres it binds.
      if (v !== "1:30:00") expect(() => pg.toDriver(v)).toThrow();
      expect(() => sqlite.toDriver(v === "1:30:00" ? "1:30" : v)).toThrow();
    });
  }
  for (const v of vectors.postgres) {
    test(`Postgres text ${v.in} reads as ${v.out}`, () => {
      expect(pg.fromDriver(v.in)).toBe(v.out);
    });
  }
  for (const v of vectors.postgresRefused) {
    test(`Postgres text ${v} is refused on read and on bind`, () => {
      expect(() => pg.fromDriver(v)).toThrow();
      expect(() => pg.toDriver(v)).toThrow();
    });
  }
  test("a node-postgres interval object reads as the canonical form; a month part is refused", () => {
    expect(pg.fromDriver({ days: 1, hours: 2 })).toBe("PT26H");
    expect(pg.fromDriver({ minutes: -1, seconds: -30 })).toBe("-PT1M30S");
    expect(pg.fromDriver({ seconds: 1, milliseconds: 500.25 })).toBe("PT1.50025S");
    expect(() => pg.fromDriver({ months: 1 })).toThrow(/year or month/);
    expect(() => pg.fromDriver(1.5)).toThrow();
    expect(() => pg.fromDriver(true)).toThrow();
  });
});

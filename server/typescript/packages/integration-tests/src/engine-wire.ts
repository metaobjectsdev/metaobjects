// engine-wire.ts — what a non-Postgres engine's driver hands the runtime, mapped onto the
// wire form the corpus asserts (`expect`, which is the Postgres value and is never loosened).
//
// The corpus pins a report column's wire form by its declared type (report-shapes.json,
// contract Table B): a `long` measure is a string, a `decimal` is a canonical decimal string,
// a time bucket is `YYYY-MM-DD` or a UTC `...Z` instant. node-postgres happens to deliver those
// spellings. The other engines deliver the same VALUES in their drivers' spellings:
//
//   SQLite  one INTEGER storage class, so a count is a JS number; a ratio is a REAL, so a whole
//           one (`1.0`) is a JS integer and a fractional one a double; an instant is the TEXT the
//           writer stored (`...T03:00:00.000Z`).
//   MySQL   BIGINT and DECIMAL arrive as strings (the connection asks for `bigNumberStrings`),
//           but a DECIMAL keeps its scale (`0.7500`, `60.0000`), and a DATETIME is a naive
//           `YYYY-MM-DD HH:MM:SS.fff` holding the UTC wall clock.
//
// This module applies the declared type to the driver value. It maps spelling only: a wrong
// VALUE still fails the comparison, which is the point of the lane. It runs on the actual side
// of a report row; an unknown entity, a non-report row and a null pass through untouched.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalFloat } from "./normalization.ts";
import { CORPUS_DIR } from "./paths.ts";

export type WireEngine = "sqlite" | "mysql";

interface ShapeField { readonly name: string; readonly subType: string }

let shapes: Map<string, Map<string, string>> | undefined;

/** report entity simple name -> (field name -> subType), from the committed report-shapes.json. */
function reportShapes(): Map<string, Map<string, string>> {
  if (shapes) return shapes;
  const parsed = JSON.parse(readFileSync(join(CORPUS_DIR, "report-shapes.json"), "utf8")) as {
    reports: ReadonlyArray<{ report: string; fields: ReadonlyArray<ShapeField> }>;
  };
  shapes = new Map(
    parsed.reports.map((r) => [
      r.report.slice(r.report.lastIndexOf(":") + 1),
      new Map(r.fields.map((f) => [f.name, f.subType])),
    ]),
  );
  return shapes;
}

/** Canonical decimal text: no trailing fractional zeros, no bare `.`. */
function decimalText(v: unknown): unknown {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : canonicalFloat(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) {
    return v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
  }
  return v;
}

const pad = (n: number): string => n.toString().padStart(2, "0");

/** An instant -> `YYYY-MM-DDTHH:MM:SS[.fff]Z` in UTC, the corpus' TIMESTAMPTZ spelling. */
function instantText(engine: WireEngine, v: unknown): unknown {
  if (typeof v !== "string") return v;
  // MySQL DATETIME has no zone: the lane holds the UTC wall clock, so read it as UTC.
  const iso = engine === "mysql" && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return v;
  const ms = d.getUTCMilliseconds();
  const frac = ms === 0 ? "" : `.${String(ms).padStart(3, "0").replace(/0+$/, "")}`;
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}Z`
  );
}

/** Map one row of report `entity` from `engine`'s driver spelling onto the corpus' wire form. */
export function toWireRow(engine: WireEngine, entity: string, row: Record<string, unknown>): Record<string, unknown> {
  const fields = reportShapes().get(entity);
  if (!fields) return row;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    if (value === null || value === undefined) { out[name] = value; continue; }
    switch (fields.get(name)) {
      case "long":
      case "currency": // integral minor units: a BIGINT on the wire, like a count
        out[name] = typeof value === "number" || typeof value === "bigint" ? String(value) : value;
        break;
      case "decimal":
        out[name] = decimalText(value);
        break;
      case "timestamp":
        out[name] = instantText(engine, value);
        break;
      default:
        out[name] = value;
    }
  }
  return out;
}

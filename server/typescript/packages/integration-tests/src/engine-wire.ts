// engine-wire.ts — what a non-Postgres engine's driver hands the runtime, mapped onto the
// wire form the corpus asserts (`expect`, which is the Postgres value and is never loosened).
//
// The corpus pins a report column's wire form by its declared type (report-shapes.json,
// contract Table B): a `long` measure is a string, a `decimal` is a canonical decimal string,
// a time bucket is `YYYY-MM-DD` or a UTC `...Z` instant. node-postgres happens to deliver those
// spellings. The other engines deliver the same VALUES in their drivers' spellings:
//
//   SQLite  one INTEGER storage class, so a count is a JS number; an instant is the TEXT the
//           writer stored (`...T03:00:00.000Z`).
//   MySQL   BIGINT arrives as a string (the connection asks for `bigNumberStrings`), and a DATETIME is a naive
//           `YYYY-MM-DD HH:MM:SS.fff` holding the UTC wall clock.
//
// This module applies the declared type to the driver value. It maps spelling only: a wrong
// VALUE still fails the comparison, which is the point of the lane. It runs on the actual side
// of a report row; an unknown entity, a non-report row and a null pass through untouched.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CANONICAL_DIR, REPORT_SHAPES_PATH } from "./paths.ts";

export type WireEngine = "sqlite" | "mysql";

interface ShapeField { readonly name: string; readonly subType: string; readonly typeSource: string | null }

interface WireField { readonly subType: string; readonly localTime: boolean }

let shapes: Map<string, Map<string, WireField>> | undefined;
let localTimeFields: Set<string> | undefined;

/**
 * `Entity.field` of every `@localTime` timestamp in the canonical model: a naive TIMESTAMP, whose
 * wire form carries no zone (`2026-05-04T22:10:00`), unlike a TIMESTAMPTZ's `...Z`. Read from the
 * model's JSON rather than re-declared here.
 */
function localTimeTimestamps(): Set<string> {
  if (localTimeFields) return localTimeFields;
  const out = new Set<string>();
  const root = JSON.parse(readFileSync(join(CANONICAL_DIR, "meta.fitness.json"), "utf8")) as { "metadata.root": { children?: unknown[] } };
  for (const node of root["metadata.root"].children ?? []) {
    const [, body] = Object.entries(node as Record<string, { name?: string; children?: unknown[] }>)[0] ?? [];
    for (const child of body?.children ?? []) {
      const [type, attrs] = Object.entries(child as Record<string, Record<string, unknown>>)[0] ?? [];
      if (type === "field.timestamp" && attrs?.["@localTime"] === true) out.add(`${body?.name}.${attrs["name"]}`);
    }
  }
  localTimeFields = out;
  return out;
}

/** True when the field's type comes from a `@localTime` timestamp of the model. */
function localTimeOf(f: ShapeField): boolean {
  return f.typeSource !== null && localTimeTimestamps().has(f.typeSource.slice(f.typeSource.lastIndexOf(":") + 1));
}

/** report entity simple name -> (field name -> subType and zone-ness), from the committed report-shapes.json. */
function reportShapes(): Map<string, Map<string, WireField>> {
  if (shapes) return shapes;
  const parsed = JSON.parse(readFileSync(REPORT_SHAPES_PATH, "utf8")) as {
    reports: ReadonlyArray<{ report: string; fields: ReadonlyArray<ShapeField> }>;
  };
  shapes = new Map(
    parsed.reports.map((r) => [
      r.report.slice(r.report.lastIndexOf(":") + 1),
      new Map(r.fields.map((f) => [f.name, { subType: f.subType, localTime: localTimeOf(f) }])),
    ]),
  );
  return shapes;
}

/**
 * Per plain entity of the canonical model, the fields whose driver spelling differs from the
 * corpus' wire form, for the rows of a non-report entity (the W4 decimal scenarios read `Entry`,
 * the guarded-update scenario reads `Program` back). `long` and `currency`: the wire form for a
 * BIGINT is a string, which node-postgres delivers and SQLite (one INTEGER storage class) hands
 * over as a number. `timestamp`: a MySQL DATETIME arrives as naive `YYYY-MM-DD HH:MM:SS.fff` text.
 */
interface EntityWireFields { readonly integral: ReadonlySet<string>; readonly timestamps: ReadonlyMap<string, boolean> }
let entityWire: Map<string, EntityWireFields> | undefined;
function entityWireFields(entity: string): EntityWireFields | undefined {
  if (!entityWire) {
    entityWire = new Map();
    const root = JSON.parse(readFileSync(join(CANONICAL_DIR, "meta.fitness.json"), "utf8")) as { "metadata.root": { children?: unknown[] } };
    for (const node of root["metadata.root"].children ?? []) {
      const [type, body] = Object.entries(node as Record<string, { name?: string; children?: unknown[] }>)[0] ?? [];
      if (type !== "object.entity" || body?.name === undefined) continue;
      const integral = new Set<string>();
      const timestamps = new Map<string, boolean>();
      for (const child of body.children ?? []) {
        const [ctype, attrs] = Object.entries(child as Record<string, Record<string, unknown>>)[0] ?? [];
        const name = attrs?.["name"];
        if (typeof name !== "string") continue;
        if (ctype === "field.long" || ctype === "field.currency") integral.add(name);
        // the value: whether the timestamp is naive (`@localTime`), which keeps its wire form zone-free
        if (ctype === "field.timestamp") timestamps.set(name, attrs?.["@localTime"] === true);
      }
      entityWire.set(body.name, { integral, timestamps });
    }
  }
  return entityWire.get(entity);
}

const pad = (n: number): string => n.toString().padStart(2, "0");

/**
 * An instant -> `YYYY-MM-DDTHH:MM:SS[.fff]Z` in UTC, the corpus' TIMESTAMPTZ spelling; a naive
 * (`@localTime`) timestamp keeps the wall clock and carries no `Z`, as it does on Postgres.
 */
function instantText(engine: WireEngine, v: unknown, localTime: boolean): unknown {
  if (typeof v !== "string") return v;
  // MySQL DATETIME has no zone: the lane holds the UTC wall clock, so read it as UTC. A naive
  // value from any engine is read as UTC too, so the host's zone cannot move its wall clock.
  const zoned = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v);
  const iso = (engine === "mysql" || localTime) && !zoned ? `${v.replace(" ", "T")}Z` : v;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return v;
  const ms = d.getUTCMilliseconds();
  const frac = ms === 0 ? "" : `.${String(ms).padStart(3, "0").replace(/0+$/, "")}`;
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}${localTime ? "" : "Z"}`
  );
}

/** The decimal-typed field names of report `entity`, from report-shapes.json; empty for any other entity. */
export function reportDecimalFields(entity: string): readonly string[] {
  const fields = reportShapes().get(entity);
  return fields === undefined ? [] : [...fields].filter(([, f]) => f.subType === "decimal").map(([n]) => n);
}

/** Map one row of report `entity` from `engine`'s driver spelling onto the corpus' wire form. */
export function toWireRow(engine: WireEngine, entity: string, row: Record<string, unknown>): Record<string, unknown> {
  const fields = reportShapes().get(entity);
  if (!fields) {
    const wire = entityWireFields(entity);
    if (wire === undefined) return row;
    return Object.fromEntries(
      Object.entries(row).map(([k, v]) => {
        if (wire.integral.has(k) && (typeof v === "number" || typeof v === "bigint")) return [k, String(v)];
        // SQLite hands back the TEXT the writer stored, which is already the wire form; only a
        // MySQL DATETIME needs its spelling mapped.
        const localTime = wire.timestamps.get(k);
        if (engine === "mysql" && localTime !== undefined) return [k, instantText(engine, v, localTime)];
        return [k, v];
      }),
    );
  }
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    if (value === null || value === undefined) { out[name] = value; continue; }
    const field = fields.get(name);
    switch (field?.subType) {
      case "long":
      case "currency": // integral minor units: a BIGINT on the wire, like a count
        out[name] = typeof value === "number" || typeof value === "bigint" ? String(value) : value;
        break;
      case "decimal":
        // ADR-0019 Amendment 1: the runtime hands a decimal back as its canonical string on every
        // engine, so there is nothing to map. This lane used to canonicalize a double here, which
        // hid a runtime that returned one; the typed gate in query-scenario.ts now refuses it.
        out[name] = value;
        break;
      case "timestamp":
        out[name] = instantText(engine, value, field?.localTime === true);
        break;
      default:
        out[name] = value;
    }
  }
  return out;
}

// The OUTPUT form of a generated REST surface: the `wire` project setting (ADR-0019 Amendment 2).
// A generated route passes the options below to a mount helper; the helper rewrites each row it
// sends. Input rules do not follow the setting (decimal bodies are parsed by the generated write
// schemas, filter operands by the filter parser).
//
//   decimals    `native` (default): the string the TS type holds, not canonicalized
//               (`decimalToNative`); `string`: the canonical W1 string (`decimalToWire`).
//   nullMembers a value object's members. `native` (default): as stored. `omit`: a null member
//               is dropped. `emit`: every DECLARED member is present, `null` when unset.
//
// Which columns are decimals and which hold value objects comes from the model, never from the
// shape of a value, so the generated route carries both as static data.

import { withDecimals, type DecimalWireMode } from "./decimal-wire.js";

/** `wire.nullMembers`. */
export type NullMembersMode = "native" | "emit" | "omit";

/**
 * The declared shape of a value object held by a jsonb column: its member names, and the shape
 * of any member that is itself a value object. `map` marks a `field.map` of value objects (the
 * column's value is an object keyed by arbitrary text, each value a value object). An array
 * (`isArray`) needs no flag: the walk reads the value's own shape.
 */
export interface ValueObjectShape {
  readonly members: readonly string[];
  readonly map?: boolean;
  readonly nested?: Readonly<Record<string, ValueObjectShape>>;
}

/** The wire options every read-side mount takes beside its other options. */
export interface WireOptions {
  /**
   * The names of the entity's `field.decimal` fields. Each row sent is rewritten under these
   * keys: `native` (default) leaves the string a driver returned and renders a SQLite number at
   * 15 significant digits; `decimalWire: "string"` sends the canonical string (ADR-0019
   * Amendment 1). The generated route passes them; absent, rows are sent as read.
   */
  readonly decimalColumns?: readonly string[];
  /** `wire.decimals`. Default `native`. */
  readonly decimalWire?: DecimalWireMode;
  /** `wire.nullMembers` for the members of the value objects under `valueObjects`. Default `native`. */
  readonly nullMembers?: NullMembersMode;
  /** The jsonb columns that hold a value object (or an array / map of them), by column name. */
  readonly valueObjects?: Readonly<Record<string, ValueObjectShape>>;
  /**
   * Credential fields (a `view.password` field): removed from every row sent, on list, get,
   * the echo of a create or update, and an M:N traversal. The generated route passes them;
   * absent, rows are sent as read.
   */
  readonly hiddenColumns?: readonly string[];
}

/** Remove `hidden` keys from a row. `undefined` when there is nothing to hide. */
export function hiddenColumnsWire(hidden: readonly string[] | undefined): ((row: unknown) => unknown) | undefined {
  if (hidden === undefined || hidden.length === 0) return undefined;
  return (row) => (isPlainObject(row) ? omitKeys(row, hidden) : row);
}

/**
 * Remove `denied` keys from a request body, before it is validated. The route's schema is the
 * entity's shared `Insert`/`Update` schema, which app code writes through too, so the API
 * boundary strips here and the schema stays whole. A key stripped is IGNORED, never rejected
 * (the uniform rule for every key outside the settable set, `@mutability: writeOnce` on PATCH
 * among them): a generated edit form submits every field it was given.
 */
export function stripDeniedColumns(body: unknown, denied: readonly string[] | undefined): unknown {
  if (denied === undefined || denied.length === 0 || !isPlainObject(body)) return body;
  return omitKeys(body, denied);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A shallow copy of `obj` without the named keys. */
function omitKeys(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out = { ...obj };
  for (const key of keys) delete out[key];
  return out;
}

function shapeMember(value: Record<string, unknown>, shape: ValueObjectShape, mode: NullMembersMode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (mode === "emit") {
    // Every declared member, in declaration order, null when unset.
    for (const m of shape.members) out[m] = m in value && value[m] !== undefined ? value[m] : null;
    for (const [k, v] of Object.entries(value)) if (!(k in out) && v !== undefined) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) out[k] = v;
  }
  for (const [name, inner] of Object.entries(shape.nested ?? {})) {
    if (name in out && out[name] !== null) out[name] = shapeValue(out[name], inner, mode);
  }
  return out;
}

/** Apply `mode` to a stored value object, an array of them, or (for `shape.map`) a map of them. */
function shapeValue(value: unknown, shape: ValueObjectShape, mode: NullMembersMode): unknown {
  if (Array.isArray(value)) return value.map((el) => shapeValue(el, shape, mode));
  if (!isPlainObject(value)) return value;
  if (shape.map === true) {
    // Keys are arbitrary text, never compared with the value object's member names.
    const out: Record<string, unknown> = {};
    for (const [k, el] of Object.entries(value)) out[k] = isPlainObject(el) ? shapeMember(el, shape, mode) : el;
    return out;
  }
  return shapeMember(value, shape, mode);
}

/** Rewrite the value-object columns of a row per `mode`. `undefined` when there is nothing to do. */
export function nullMembersWire(
  shapes: Readonly<Record<string, ValueObjectShape>> | undefined,
  mode: NullMembersMode | undefined,
): ((row: unknown) => unknown) | undefined {
  if (shapes === undefined || mode === undefined || mode === "native") return undefined;
  const entries = Object.entries(shapes);
  if (entries.length === 0) return undefined;
  return (row) => {
    if (!isPlainObject(row)) return row;
    const out = { ...row };
    for (const [column, shape] of entries) {
      if (column in out && out[column] !== null && out[column] !== undefined) out[column] = shapeValue(out[column], shape, mode);
    }
    return out;
  };
}

/** A wire mapper: `base` (timestamps), then the decimal rewrite, the null-member rewrite, then the credential strip. */
export function withWire(base: (row: unknown) => unknown, opts: WireOptions): (row: unknown) => unknown {
  const decimals = withDecimals(base, opts.decimalColumns, opts.decimalWire);
  const members = nullMembersWire(opts.valueObjects, opts.nullMembers);
  const hidden = hiddenColumnsWire(opts.hiddenColumns);
  const shaped = members === undefined ? decimals : (row: unknown) => members(decimals(row));
  return hidden === undefined ? shaped : (row) => hidden(shaped(row));
}

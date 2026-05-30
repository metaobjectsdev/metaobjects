import type { NormalizeMode } from "./normalize.js";

// FR-010 recover engine — types & model (Tier-2 idiomatic TS port).
//
// Cross-port REFERENCE is the Java engine
// (server/java/render/.../recover/). This file ports the Java records/enums to
// idiomatic TS: enums become string-union `as const` objects (values match the
// corpus / Java enum names exactly), records become readonly interfaces +
// factory functions, and the mutable RecoveryReport is a class.

/** Output format the dirty text claims to be. Corpus schema.json uses "JSON"/"XML". */
export const Format = {
  JSON: "JSON",
  XML: "XML",
} as const;
export type Format = (typeof Format)[keyof typeof Format];

/** The coercion target kinds the engine understands. OBJECT = nested RecoverSchema. */
export const FieldKind = {
  STRING: "STRING",
  INT: "INT",
  LONG: "LONG",
  DOUBLE: "DOUBLE",
  BOOLEAN: "BOOLEAN",
  ENUM: "ENUM",
  OBJECT: "OBJECT",
} as const;
export type FieldKind = (typeof FieldKind)[keyof typeof FieldKind];

/**
 * FROZEN cross-port per-field recovery classification. Do not reorder or add
 * without an ADR. These string values are SERIALIZED in the conformance corpus.
 */
export const FieldRecovery = {
  RECOVERED: "RECOVERED",
  // DEFAULTED is reserved (a future @default-backed value); the engine does not emit it yet.
  DEFAULTED: "DEFAULTED",
  LOST_OPTIONAL: "LOST_OPTIONAL",
  LOST_REQUIRED: "LOST_REQUIRED",
  MALFORMED: "MALFORMED",
} as const;
export type FieldRecovery = (typeof FieldRecovery)[keyof typeof FieldRecovery];

/**
 * STRICT: case-sensitive, minimal repair. NORMAL: case-insensitive keys/tags
 * (default). LOOSE: maximal repair (currently identical to NORMAL — reserved).
 */
export const Tolerance = {
  STRICT: "STRICT",
  NORMAL: "NORMAL",
  LOOSE: "LOOSE",
} as const;
export type Tolerance = (typeof Tolerance)[keyof typeof Tolerance];

/** A recorded normalization/coercion. kind e.g. "normalize", "alias", "runtime-alias-override", "clamp", "coerceDefault", "default". */
export interface Coercion {
  readonly fieldPath: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
}

/**
 * One field's recover descriptor. enumValues/enumAlias non-null only for ENUM;
 * min/max non-null only for numeric range constraints; nested non-null only for OBJECT.
 */
export interface FieldSpec {
  readonly name: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly array: boolean;
  readonly enumValues: readonly string[] | null;
  readonly enumAlias: Readonly<Record<string, string>> | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly nested: RecoverSchema | null;
  /** FR-011: present-but-uncoercible fallback member (from `@coerceDefault`). ENUM-only; null = none. */
  readonly coerceDefault: string | null;
  /** FR-011: absent-fill member (from `@default`). ENUM-only; null = none. */
  readonly defaultValue: string | null;
  /** FR-011: resolved enum normalization mode (from `@normalize`; default `"strip"`). */
  readonly normalize: NormalizeMode;
}

export function scalar(name: string, kind: FieldKind, required: boolean): FieldSpec {
  return {
    name,
    kind,
    required,
    array: false,
    enumValues: null,
    enumAlias: null,
    min: null,
    max: null,
    nested: null,
    coerceDefault: null,
    defaultValue: null,
    normalize: "strip",
  };
}

export function enumField(
  name: string,
  required: boolean,
  values: readonly string[] | null,
  aliases: Readonly<Record<string, string>> | null,
  coerceDefault?: string | null,
  normalize: NormalizeMode = "strip",
  defaultValue?: string | null,
): FieldSpec {
  return {
    name,
    kind: FieldKind.ENUM,
    required,
    array: false,
    enumValues: values == null ? null : [...values],
    enumAlias: aliases == null ? {} : { ...aliases },
    min: null,
    max: null,
    nested: null,
    coerceDefault: coerceDefault ?? null,
    defaultValue: defaultValue ?? null,
    normalize,
  };
}

export function range(
  name: string,
  kind: FieldKind,
  required: boolean,
  min: number | null,
  max: number | null,
): FieldSpec {
  return {
    name,
    kind,
    required,
    array: false,
    enumValues: null,
    enumAlias: null,
    min,
    max,
    nested: null,
    coerceDefault: null,
    defaultValue: null,
    normalize: "strip",
  };
}

export function object(name: string, required: boolean, array: boolean, nested: RecoverSchema | null): FieldSpec {
  return {
    name,
    kind: FieldKind.OBJECT,
    required,
    array,
    enumValues: null,
    enumAlias: null,
    min: null,
    max: null,
    nested,
    coerceDefault: null,
    defaultValue: null,
    normalize: "strip",
  };
}

/** Top-level recover descriptor. rootName = the XML root tag / logical JSON root name. */
export interface RecoverSchema {
  readonly format: Format;
  readonly rootName: string;
  readonly fields: readonly FieldSpec[];
}

export function recoverSchema(format: Format, rootName: string, fields: readonly FieldSpec[] | null): RecoverSchema {
  return { format, rootName, fields: fields == null ? [] : [...fields] };
}

/**
 * ctx carries the field path and the FieldSpec; return null to fall through to
 * default coercion. The single bespoke-coercion hook (the bounded "20%").
 */
export type OnField = (fieldPath: string, rawValue: string, spec: FieldSpec) => unknown | null;

/**
 * Bounded runtime override surface. aliases/normalizers are MERGED with the
 * schema's, runtime winning on key conflict. onField is the single hook.
 */
export interface RecoverOptions {
  readonly tolerance: Tolerance;
  readonly aliases: Readonly<Record<string, string>>;
  readonly normalizers: Readonly<Record<string, (raw: string) => unknown | null>>;
  readonly onField: OnField | null;
}

export function defaults(): RecoverOptions {
  return { tolerance: Tolerance.NORMAL, aliases: {}, normalizers: {}, onField: null };
}

/** Normalize a partial / undefined options bag into a complete RecoverOptions. */
export function normalizeOptions(opts?: Partial<RecoverOptions> | null): RecoverOptions {
  if (opts == null) return defaults();
  return {
    tolerance: opts.tolerance ?? Tolerance.NORMAL,
    aliases: opts.aliases == null ? {} : { ...opts.aliases },
    normalizers: opts.normalizers == null ? {} : { ...opts.normalizers },
    onField: opts.onField ?? null,
  };
}

/** Engine return. data is a forgiving record; Phase-2 codegen wraps it into a typed RecoveryResult<T>. */
export interface RecoverOutcome {
  readonly data: Record<string, unknown>;
  readonly report: RecoveryReport;
}

/** Typed result of a generated recover(...): best-effort value (null where lost/malformed) + report. */
export interface RecoveryResult<T> {
  readonly data: T | null;
  readonly report: RecoveryReport;
}

/** Mutable accumulator of per-field recovery classification, the degenerate-response flag, and coercion notes. */
export class RecoveryReport {
  // Insertion-ordered (Map preserves insertion order, mirroring Java LinkedHashMap).
  private readonly _states = new Map<string, FieldRecovery>();
  private readonly _coercions: Coercion[] = [];
  private _empty = false;

  set(fieldPath: string, state: FieldRecovery): void {
    this._states.set(fieldPath, state);
  }

  addCoercion(c: Coercion): void {
    this._coercions.push(c);
  }

  markEmpty(): void {
    this._empty = true;
  }

  isEmpty(): boolean {
    return this._empty;
  }

  states(): ReadonlyMap<string, FieldRecovery> {
    return new Map(this._states);
  }

  coercions(): readonly Coercion[] {
    return [...this._coercions];
  }

  lostRequired(): string[] {
    return this.byState(FieldRecovery.LOST_REQUIRED);
  }

  malformed(): string[] {
    return this.byState(FieldRecovery.MALFORMED);
  }

  hasLostRequired(): boolean {
    return this.lostRequired().length > 0;
  }

  private byState(s: FieldRecovery): string[] {
    const out: string[] = [];
    for (const [k, v] of this._states) if (v === s) out.push(k);
    return out;
  }
}

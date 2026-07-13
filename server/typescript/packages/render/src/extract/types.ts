import type { NormalizeMode } from "./normalize.js";

// FR-010 extract engine — types & model (Tier-2 idiomatic TS port).
//
// Cross-port REFERENCE is the Java engine
// (server/java/render/.../extract/). This file ports the Java records/enums to
// idiomatic TS: enums become string-union `as const` objects (values match the
// corpus / Java enum names exactly), records become readonly interfaces +
// factory functions, and the mutable ExtractionReport is a class.

/** Output format the dirty text claims to be. Corpus schema.json uses "JSON"/"XML". */
export const Format = {
  JSON: "JSON",
  XML: "XML",
} as const;
export type Format = (typeof Format)[keyof typeof Format];

/** The coercion target kinds the engine understands. OBJECT = nested ExtractSchema. */
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
 * FROZEN cross-port per-field extraction classification. Do not reorder or add
 * without an ADR. These string values are SERIALIZED in the conformance corpus.
 */
export const FieldExtraction = {
  EXTRACTED: "EXTRACTED",
  // A `@default`/`@coerceDefault`-backed value (absent-fill or present-but-uncoercible fallback).
  DEFAULTED: "DEFAULTED",
  LOST_OPTIONAL: "LOST_OPTIONAL",
  LOST_REQUIRED: "LOST_REQUIRED",
  MALFORMED: "MALFORMED",
} as const;
export type FieldExtraction = (typeof FieldExtraction)[keyof typeof FieldExtraction];

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
 * One field's extract descriptor. enumValues/enumAlias non-null only for ENUM;
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
  readonly nested: ExtractSchema | null;
  /** FR-011: present-but-uncoercible fallback member (from `@coerceDefault`). ENUM-only; null = none. */
  readonly coerceDefault: string | null;
  /**
   * Absent-fill default (from `@default`). When the field is ABSENT, extract fills this value
   * → DEFAULTED (which satisfies `@required`). Generalized to ALL field kinds (Phase B): for an
   * enum it is the member string verbatim; for a non-enum it is coerced to `kind` via the pure
   * scalar coerce (so `@default "0"` on `field.int` yields integer 0). null = no default.
   */
  readonly defaultValue: string | null;
  /** FR-011: resolved enum normalization mode (from `@normalize`; default `"strip"`). */
  readonly normalize: NormalizeMode;
  /**
   * `@xmlText`: this field receives its element's TEXT CONTENT (analogous to JAXB `@XmlValue` /
   * Jackson `@JacksonXmlText` / .NET `[XmlText]`). The extract engine reads it from the
   * `#text` sentinel the lenient XML reader carries when an element has both attributes and a
   * text body, instead of a same-named child. Absent/false for normal fields and for JSON.
   */
  readonly textContent?: boolean;
}

/**
 * A scalar field, optionally carrying an absent-fill `@default` (Phase B — generalized
 * `@default`). When ABSENT from the model response, extract coerces `defaultValue` to `kind`
 * and classifies the field DEFAULTED (which satisfies `@required`). `defaultValue == null` is
 * the no-default case (back-compat with the original two-arg call).
 */
export function scalar(
  name: string,
  kind: FieldKind,
  required: boolean,
  defaultValue?: string | null,
): FieldSpec {
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
    defaultValue: defaultValue ?? null,
    normalize: "strip",
  };
}

/**
 * A field that receives its element's TEXT CONTENT — the `@xmlText` marker (see
 * {@link FieldSpec.textContent}). A scalar with the `textContent` flag set; coerced to `kind`.
 */
export function textContentField(name: string, kind: FieldKind, required: boolean): FieldSpec {
  return { ...scalar(name, kind, required), textContent: true };
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

/**
 * Phase B (array-of-enum): an enum field that is a list (`array === true`). Each element flows
 * through the SAME enum coercion pipeline a scalar enum uses (exact → normalize → `@enumAlias`
 * → `@coerceDefault` → MALFORMED) and is classified independently by indexed path (`tags[0]`,
 * `tags[1]`, …). Mirrors {@link enumField} but with `array = true`.
 */
export function enumArray(
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
    array: true,
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

export function object(name: string, required: boolean, array: boolean, nested: ExtractSchema | null): FieldSpec {
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

/** Top-level extract descriptor. rootName = the XML root tag / logical JSON root name. */
export interface ExtractSchema {
  readonly format: Format;
  readonly rootName: string;
  readonly fields: readonly FieldSpec[];
}

export function extractSchema(format: Format, rootName: string, fields: readonly FieldSpec[] | null): ExtractSchema {
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
 *
 * `rootless` (XML only): when `true`, the input has NO enclosing root element — the payload's
 * fields ARE the top-level elements (a flat sequence like `<a>..</a><b>..</b>`). The engine
 * parses those top-level elements directly instead of locating a `<rootName>` span, so the caller
 * need not synthesize a wrapper. No effect for JSON. Default `false` (a single root element is
 * expected, as before). Mirrors Java ExtractOptions.rootless.
 */
export interface ExtractOptions {
  readonly tolerance: Tolerance;
  readonly aliases: Readonly<Record<string, string>>;
  readonly normalizers: Readonly<Record<string, (raw: string) => unknown | null>>;
  readonly onField: OnField | null;
  readonly rootless: boolean;
}

export function defaults(): ExtractOptions {
  return { tolerance: Tolerance.NORMAL, aliases: {}, normalizers: {}, onField: null, rootless: false };
}

/** Normalize a partial / undefined options bag into a complete ExtractOptions. */
export function normalizeOptions(opts?: Partial<ExtractOptions> | null): ExtractOptions {
  if (opts == null) return defaults();
  return {
    tolerance: opts.tolerance ?? Tolerance.NORMAL,
    aliases: opts.aliases == null ? {} : { ...opts.aliases },
    normalizers: opts.normalizers == null ? {} : { ...opts.normalizers },
    onField: opts.onField ?? null,
    rootless: opts.rootless ?? false,
  };
}

/** Engine return. data is a forgiving record; Phase-2 codegen wraps it into a typed ExtractionResult<T>. */
export interface ExtractionOutcome {
  readonly data: Record<string, unknown>;
  readonly report: ExtractionReport;
}

/** Typed result of a generated extract(...): best-effort value (null where lost/malformed) + report. */
export interface ExtractionResult<T> {
  readonly data: T | null;
  readonly report: ExtractionReport;
}

/**
 * Thrown by {@link orThrow} when a {@link ExtractionResult} lost a `@required` field. Mirrors
 * Java's `ExtractException`. Carries the list of lost-required field paths.
 */
export class ExtractError extends Error {
  readonly lostRequired: readonly string[];
  constructor(lostRequired: readonly string[]) {
    super(`extract: required field(s) lost: ${lostRequired.join(", ")}`);
    this.name = "ExtractError";
    this.lostRequired = [...lostRequired];
  }
}

/**
 * Opt-in strictness over a never-throwing {@link ExtractionResult}. Mirrors Java
 * `ExtractionResult.orThrow()`. Throws a {@link ExtractError} iff the report has a lost
 * `@required` field; otherwise returns `result.data`.
 *
 * <p>TS divergence from Java (documented): `ExtractionResult` is a plain interface (the generated
 * output-parsers build it as an object literal), so `orThrow` is a free function rather than a
 * method on the result. Semantics are identical.</p>
 */
export function orThrow<T>(result: ExtractionResult<T>): T | null {
  if (result.report.hasLostRequired()) {
    throw new ExtractError(result.report.lostRequired());
  }
  return result.data;
}

/** Mutable accumulator of per-field extraction classification, the degenerate-response flag, and coercion notes. */
export class ExtractionReport {
  // Insertion-ordered (Map preserves insertion order, mirroring Java LinkedHashMap).
  private readonly _states = new Map<string, FieldExtraction>();
  private readonly _coercions: Coercion[] = [];
  private readonly _defaultedRequired = new Set<string>();
  private _empty = false;

  set(fieldPath: string, state: FieldExtraction): void {
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

  states(): ReadonlyMap<string, FieldExtraction> {
    return new Map(this._states);
  }

  coercions(): readonly Coercion[] {
    return [...this._coercions];
  }

  lostRequired(): string[] {
    return this.byState(FieldExtraction.LOST_REQUIRED);
  }

  malformed(): string[] {
    return this.byState(FieldExtraction.MALFORMED);
  }

  hasLostRequired(): boolean {
    return this.lostRequired().length > 0;
  }

  /** Every field the document did not answer, whose value came from its `@default`. */
  defaulted(): string[] {
    return this.byState(FieldExtraction.DEFAULTED);
  }

  /**
   * The dangerous subset: **`@required` fields the document did NOT answer**, whose value
   * was silently supplied by their `@default`.
   *
   * These do NOT appear in `lostRequired()`, and that is deliberate — a default IS an
   * answer, so the field is not "lost". But it means a `@default` **switches off loss
   * detection for that field**, including in generated code: the generated extractor and
   * `dataOrThrow()` both key their failure signal on `hasLostRequired()`, so a required
   * field with a default can never make them fire.
   *
   * That is a sharp edge worth being able to SEE. It propagates through `extends` — adding
   * an innocuous `@default` to a shared abstract field silently disables loss detection for
   * every field inheriting it — and a missing value then becomes indistinguishable from a
   * real one. Check this alongside `hasLostRequired()` when an absent answer must not be
   * mistaken for a given one.
   */
  defaultedRequired(): string[] {
    return [...this._defaultedRequired];
  }

  hasDefaultedRequired(): boolean {
    return this._defaultedRequired.size > 0;
  }

  /** Called by extract when an absent **required** field is filled from its `@default`. */
  markDefaultedRequired(fieldPath: string): void {
    this._defaultedRequired.add(fieldPath);
  }

  private byState(s: FieldExtraction): string[] {
    const out: string[] = [];
    for (const [k, v] of this._states) if (v === s) out.push(k);
    return out;
  }
}

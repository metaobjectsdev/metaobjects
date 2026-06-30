/**
 * Canonical, dialect-neutral SQL type. Both buildExpectedSchema (metadata→snapshot)
 * and introspect (db→snapshot) produce this shape; diff compares canonical to
 * canonical; emit re-renders to dialect-specific SQL.
 *
 * Per spec §5.2.
 */
export type SqlType =
  | { kind: "text"; maxLength?: number }
  | { kind: "integer"; bits: 32 | 64 }
  | { kind: "real" }        // DOUBLE PRECISION (float8) — field.double
  | { kind: "real4" }       // REAL (float4, single precision) — field.float
  | { kind: "numeric"; precision?: number; scale?: number }
  | { kind: "boolean" }
  | { kind: "timestamp"; withTimezone: boolean }
  | { kind: "date" }
  | { kind: "time" }
  | { kind: "json" }
  | { kind: "blob" }
  | { kind: "uuid" }
  | { kind: "inet" }        // Postgres-native inet (IPv4/IPv6) — field.inet (ADR-0036/0037 Wave 3)
  | { kind: "array"; element: SqlType };   // native SQL array (e.g. uuid[], text[])

/** Structural equality on SqlType. */
export function sqlTypeEquals(a: SqlType, b: SqlType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "text":
      return a.maxLength === (b as Extract<SqlType, { kind: "text" }>).maxLength;
    case "integer":
      return a.bits === (b as Extract<SqlType, { kind: "integer" }>).bits;
    case "numeric": {
      const bn = b as Extract<SqlType, { kind: "numeric" }>;
      return a.precision === bn.precision && a.scale === bn.scale;
    }
    case "timestamp":
      return a.withTimezone === (b as Extract<SqlType, { kind: "timestamp" }>).withTimezone;
    case "array":
      return sqlTypeEquals(a.element, (b as Extract<SqlType, { kind: "array" }>).element);
    case "real":
    case "real4":
    case "boolean":
    case "date":
    case "time":
    case "json":
    case "blob":
    case "uuid":
    case "inet":
      return true;
  }
}

/**
 * Returns true if changing column type from `from` to `to` is provably non-lossy.
 * Per spec §6.5. Conservative on purpose — false negatives just mean the user has
 * to pass `allow.typeChange`; false positives could silently corrupt data.
 *
 * Returns false for identical types (caller should not emit a change-column-type
 * in that case at all; this is defensive).
 */
export function isWidening(from: SqlType, to: SqlType): boolean {
  if (sqlTypeEquals(from, to)) return false;
  if (from.kind !== to.kind) return false;       // cross-kind: always lossy

  switch (from.kind) {
    case "text": {
      const t = to as Extract<SqlType, { kind: "text" }>;
      // unbounded → bounded: lossy
      if (from.maxLength === undefined) return false;
      // bounded → unbounded: widening
      if (t.maxLength === undefined) return true;
      // bounded both: widening iff new ≥ old
      return t.maxLength >= from.maxLength;
    }
    case "integer": {
      const t = to as Extract<SqlType, { kind: "integer" }>;
      return t.bits >= from.bits;
    }
    case "numeric": {
      const t = to as Extract<SqlType, { kind: "numeric" }>;
      const fp = from.precision ?? 0;
      const fs = from.scale ?? 0;
      const tp = t.precision ?? 0;
      const ts = t.scale ?? 0;
      // widening iff p2 ≥ p1 AND s2 = s1 AND (p2 - s2) ≥ (p1 - s1)
      return tp >= fp && ts === fs && (tp - ts) >= (fp - fs);
    }
    // real/real4/boolean/date/json/blob/uuid: same kind already handled by sqlTypeEquals;
    // any difference here means the discriminant matched but structural equality failed
    // (impossible given SqlType has no other variants for these kinds). Defensive false.
    case "real":
    case "real4":
    case "boolean":
    case "date":
    case "time":
    case "json":
    case "blob":
    case "uuid":
    case "inet":
    case "timestamp":
    case "array":
      // Array element-type changes are not auto-widened — require explicit allow.
      return false;
  }
}

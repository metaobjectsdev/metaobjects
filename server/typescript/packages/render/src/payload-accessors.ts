// Derived boolean accessors — `{{#hasFoo}}` over a payload field `foo`.
//
// A prompt needs conditional sections ("include the abilities block only when there
// ARE abilities"), and the payload contract answers that with a DERIVED accessor
// rather than an authored boolean field: the author declares `abilities`, and
// `hasAbilities` follows from it. Declaring both would let them disagree.
//
// THE RULE IS SHARED ON PURPOSE. The JVM has carried this since 7.7.7
// (`com.metaobjects.render.PayloadAccessors`, emitted by `SpringPayloadGenerator`
// onto every generated payload record and accepted by `render.Verify`), and its
// comment says the emitter and the verifier share one rule so they "can never drift
// apart". TypeScript had neither half, which is why the same template verified clean
// on the JVM and reported drift here — and, worse, RENDERED WRONG rather than
// failing: `{{#hasAbilities}}` resolved to nothing on a populated payload, so the
// section silently vanished. This module is the TS half of that shared rule.

/** The `has` prefix every derived boolean accessor carries. */
export const HAS_PREFIX = "has";

/**
 * The boolean-accessor section name for a payload field: `"has" + capitalize(name)`
 * (`abilities` → `hasAbilities`). Byte-identical to the JVM's
 * `PayloadAccessors.hasAccessorName`, including its capitalize, which leaves an
 * already-uppercase first character untouched.
 */
export function hasAccessorName(fieldName: string): string {
  return HAS_PREFIX + capitalize(fieldName);
}

/** Capitalize the first character, leaving an already-uppercase one untouched. */
export function capitalize(s: string): string {
  if (s.length === 0) return s;
  const c0 = s.charAt(0);
  if (c0 === c0.toUpperCase() && c0 !== c0.toLowerCase()) return s;
  return c0.toUpperCase() + s.slice(1);
}

/**
 * Is `value` "present" for the purposes of `has<Field>`?
 *
 * Mirrors the JVM emitter's per-type bodies exactly:
 *   string    → non-null AND non-blank   (`!foo.isBlank()`, so whitespace is absent)
 *   array     → non-null AND non-empty   (`!foo.isEmpty()`)
 *   reference → non-null                 (any other object)
 *
 * Returns `undefined` for numbers and booleans, which the JVM deliberately emits NO
 * accessor for — they are always-present scalars, and a `{{#hasCount}}` over an int
 * is drift rather than a conditional. Returning undefined (rather than false) keeps
 * that distinction: nothing is injected, so the name stays unresolved exactly as it
 * is on a generated Java record that has no such method.
 */
export function accessorValue(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return undefined;
  }
  return typeof value === "object";
}

/**
 * A view over `payload` carrying its derived `has<Field>` accessors, recursively.
 *
 * NON-MUTATING — the caller's payload is never touched, because a render must not
 * be able to change the object it was handed. An AUTHORED key always wins: if a
 * payload genuinely carries `hasFoo`, that value is kept rather than shadowed by a
 * derived one.
 *
 * Recursion follows Mustache's own scoping: every nested object and every array
 * ELEMENT becomes a context in its own right, so a section over `abilities` sees
 * the accessors of the ability it is currently iterating.
 */
export function withDerivedAccessors<T>(payload: T, depth = 0): T {
  if (depth > 32) return payload; // pathological graph; render is not a validator
  if (Array.isArray(payload)) {
    return payload.map((v) => withDerivedAccessors(v, depth + 1)) as unknown as T;
  }
  if (payload === null || typeof payload !== "object") return payload;
  // PLAIN objects only. Rebuilding from Object.entries() would flatten anything with
  // its own prototype — a Date stringifies to "[object Object]" and a class instance
  // loses its getters — and the other ports only rebuild map-shaped values, so
  // rebuilding more here would be a divergence as well as a regression.
  const proto = Object.getPrototypeOf(payload);
  if (proto !== Object.prototype && proto !== null) return payload;

  const src = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) out[k] = withDerivedAccessors(v, depth + 1);
  for (const [k, v] of Object.entries(src)) {
    const name = hasAccessorName(k);
    if (Object.prototype.hasOwnProperty.call(src, name)) continue; // authored wins
    const derived = accessorValue(v);
    if (derived !== undefined) out[name] = derived;
  }
  return out as unknown as T;
}

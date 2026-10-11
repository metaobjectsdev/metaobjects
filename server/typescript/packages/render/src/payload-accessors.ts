// Derived boolean accessors — `{{#hasFoo}}` over a payload field `foo`.
//
// A prompt needs conditional sections ("include the abilities block only when there
// ARE abilities"), and the payload contract answers that with a DERIVED accessor
// rather than an authored boolean field: the author declares `abilities`, and
// `hasAbilities` follows from it. Declaring both would let them disagree.
//
// THE RULE IS SHARED ON PURPOSE. The JVM has carried this since 7.7.7
// (`com.metaobjects.render.PayloadAccessors`, accepted by `render.Verify`; it was once
// emitted as `has<Field>()` methods on every generated payload record, and since
// ADR-0056 the JVM engine derives it from the record instead), and its comment says
// the two sides share one rule so they "can never drift apart". TypeScript had neither half, which is why the same template verified clean
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

/**
 * The positional accessor every OBJECT element of a collection carries, so a list separator
 * needs no hand-computed `last` flag in the payload:
 * `{{#items}}{{name}}{{^-last}}, {{/-last}}{{/items}}`. A boolean on the element; the leading
 * `-` cannot collide with a field name, and it is still an ordinary Mustache tag name, so the
 * template stays valid Mustache. A scalar element has nowhere to hold a key and carries none.
 * An authored member of the same name wins, as it does for `has<Field>`.
 */
export const LAST_ACCESSOR = "-last";

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
 * A view over `payload` carrying its derived accessors, recursively: `has<Field>` on every
 * object, and `-last` on every object that is an element of a collection.
 *
 * NON-MUTATING — the caller's payload is never touched, because a render must not
 * be able to change the object it was handed. An AUTHORED member always wins: if a
 * payload genuinely carries `hasFoo`, that value is kept rather than shadowed by a
 * derived one.
 *
 * Recursion follows Mustache's own scoping: every nested object and every array
 * ELEMENT becomes a context in its own right, so a section over `abilities` sees
 * the accessors of the ability it is currently iterating.
 *
 * The payload's shape does not change the result. A plain object is copied with its
 * accessors added; anything with its own prototype (a class instance, a Date) is read
 * THROUGH a view instead, so its getters, methods and string form stay exactly its own.
 */
export function withDerivedAccessors<T>(payload: T, depth = 0): T {
  return derive(payload, depth, undefined) as T;
}

/** `last` is set only for an element of a collection: its position in that collection. */
function derive(payload: unknown, depth: number, last: boolean | undefined): unknown {
  if (depth > 32) return payload; // pathological graph; render is not a validator
  if (Array.isArray(payload)) {
    const end = payload.length - 1;
    return payload.map((v, i) => derive(v, depth + 1, i === end));
  }
  if (payload === null || typeof payload !== "object") return payload;
  // Only a PLAIN object is rebuilt. Rebuilding from Object.entries() would flatten
  // anything with its own prototype — a Date stringifies to "[object Object]" and a
  // class instance loses its getters — so those are viewed, never copied.
  const proto = Object.getPrototypeOf(payload);
  if (proto !== Object.prototype && proto !== null) return typedView(payload, depth, last);

  const src = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) out[k] = derive(v, depth + 1, undefined);
  for (const [k, v] of Object.entries(src)) {
    const name = hasAccessorName(k);
    if (Object.prototype.hasOwnProperty.call(src, name)) continue; // authored wins
    const derived = accessorValue(v);
    if (derived !== undefined) out[name] = derived;
  }
  if (last !== undefined && !Object.prototype.hasOwnProperty.call(src, LAST_ACCESSOR)) {
    out[LAST_ACCESSOR] = last;
  }
  return out;
}

/** The first character lowercased — the inverse of `capitalize` for a camelCase field name. */
function decapitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * The derived-accessor view of an object that has its own prototype. Every member the
 * object has resolves to the object's own — a getter runs against the object itself, a
 * method stays bound to it — so the Mustache engine sees the names and values it always
 * did. Only a name the object does NOT have can resolve to a derived accessor.
 *
 * The proxy's target is an empty stand-in, not the object: a frozen payload would
 * otherwise forbid returning the derived view of one of its nested values.
 */
function typedView(target: object, depth: number, last: boolean | undefined): object {
  const members = new Map<PropertyKey, unknown>();
  const member = (key: PropertyKey): unknown => {
    if (members.has(key)) return members.get(key);
    const raw: unknown = Reflect.get(target, key, target);
    const value =
      typeof raw === "function"
        ? (...args: unknown[]) => derive(Reflect.apply(raw, target, args), depth + 1, undefined)
        : derive(raw, depth + 1, undefined);
    members.set(key, value);
    return value;
  };
  const derived = (key: PropertyKey): boolean | undefined => {
    if (typeof key !== "string") return undefined;
    if (key === LAST_ACCESSOR) return last;
    if (!key.startsWith(HAS_PREFIX)) return undefined;
    const rest = key.slice(HAS_PREFIX.length);
    for (const field of [decapitalize(rest), rest]) {
      if (!(field in target) || hasAccessorName(field) !== key) continue;
      const raw: unknown = Reflect.get(target, field, target);
      if (typeof raw === "function") continue;
      const value = accessorValue(raw);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  return new Proxy(Object.create(null) as object, {
    has: (_stand, key) => key in target || derived(key) !== undefined,
    get: (_stand, key) => (key in target ? member(key) : derived(key)),
  });
}

// ValueObject — the map-backed default backing object for `object.value`.
//
// Idiomatic TS port of Java's ValueObject: a string-keyed map that holds its
// MetaObject back-reference and supports both declared fields and arbitrary
// overflow keys. THE unbound default produced by MetaObject.newInstance() when
// no native type is registered for the object's FQN. Reflection-free.

import type { MetaObject } from "./meta-object.js";
import type { MetaObjectAware } from "./meta-object-aware.js";

export class ValueObject implements MetaObjectAware {
  private readonly _values = new Map<string, unknown>();
  private _metaData: MetaObject | undefined = undefined;

  /** Construct over an optional MetaObject back-reference (set at newInstance). */
  constructor(mo?: MetaObject) {
    this._metaData = mo;
  }

  // ---------------------------------------------------------------------------
  // MetaObjectAware
  // ---------------------------------------------------------------------------

  getMetaData(): MetaObject | undefined {
    return this._metaData;
  }

  setMetaData(mo: MetaObject): void {
    this._metaData = mo;
  }

  // ---------------------------------------------------------------------------
  // Map-backed value access — declared fields AND arbitrary overflow keys.
  // ---------------------------------------------------------------------------

  /** Read a value by key. Returns undefined for an unset key. */
  get(name: string): unknown {
    return this._values.get(name);
  }

  /** Write a value by key. Any string key is accepted (overflow-friendly). */
  set(name: string, value: unknown): void {
    this._values.set(name, value);
  }

  /** True if the key has been set (including to undefined). */
  has(name: string): boolean {
    return this._values.has(name);
  }

  /** Remove a key. */
  delete(name: string): boolean {
    return this._values.delete(name);
  }

  /** Insertion-ordered keys currently held. */
  keys(): string[] {
    return [...this._values.keys()];
  }

  /** A plain-object snapshot of the backing map (insertion-ordered). */
  toObject(): Record<string, unknown> {
    return Object.fromEntries(this._values);
  }
}

// MetaObjectAware — the runtime back-reference contract.
//
// Idiomatic TS port of Java's MetaObjectAware: a backing object that knows the
// MetaObject describing it. The default backing type (ValueObject) implements
// this; generated/registered native types may implement it too so they carry a
// back-reference after newInstance(). Reflection-free — no reflect-metadata,
// no runtime type resolution.

import type { MetaObject } from "./meta-object.js";

/** A backing object that carries a reference to the MetaObject describing it. */
export interface MetaObjectAware {
  /** The MetaObject describing this instance, or undefined if not yet attached. */
  getMetaData(): MetaObject | undefined;
  /** Attach the MetaObject describing this instance (back-reference). */
  setMetaData(mo: MetaObject): void;
}

/** Structural type guard — true when `o` satisfies the MetaObjectAware contract. */
export function isMetaObjectAware(o: unknown): o is MetaObjectAware {
  return (
    typeof o === "object" &&
    o !== null &&
    typeof (o as MetaObjectAware).getMetaData === "function" &&
    typeof (o as MetaObjectAware).setMetaData === "function"
  );
}

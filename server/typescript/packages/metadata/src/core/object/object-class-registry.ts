// ObjectClassRegistry — FQN → factory binding for runtime instantiation.
//
// Idiomatic TS port of Java's ObjectClassRegistry: maps an object's FQN
// (`package::name`) to a factory that produces a native backing instance.
// Generated code self-registers at import time (`registry.register(fqn, ...)`)
// — NO reflection (no Class.forName / Type.GetType / importlib equivalent),
// AOT/tree-shake-safe per ADR-0001.
//
// DISTINCT from the metadata TypeRegistry, which maps metamodel type/subType
// names to MetaData node classes. This registry maps a DATA object's FQN to a
// runtime BACKING instance factory.

import type { MetaObject } from "./meta-object.js";

/** Produces a native backing instance for the given MetaObject. */
export type ObjectFactory = (mo: MetaObject) => object;

export class ObjectClassRegistry {
  private readonly _factories = new Map<string, ObjectFactory>();

  /** Bind an FQN (`package::name`) to a backing-instance factory. */
  register(fqn: string, factory: ObjectFactory): void {
    this._factories.set(fqn, factory);
  }

  /** Resolve the factory bound to an FQN, or undefined if none is registered. */
  resolve(fqn: string): ObjectFactory | undefined {
    return this._factories.get(fqn);
  }

  /** True if a factory is bound to the FQN. */
  has(fqn: string): boolean {
    return this._factories.has(fqn);
  }

  /** Remove a binding (test/scoping convenience). */
  unregister(fqn: string): boolean {
    return this._factories.delete(fqn);
  }
}

/**
 * The module-level default registry. Generated code self-registers here at
 * import time; `MetaObject.newInstance()` consults it when no explicit registry
 * is passed. Tests should construct their own `new ObjectClassRegistry()` to
 * avoid leaking bindings across cases (scenario 6).
 */
export const defaultObjectClassRegistry = new ObjectClassRegistry();

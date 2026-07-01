# ADR-0039: `own*()` accessor discipline — resolving is the default; own is the rare exception

## Status

**Accepted** (2026-06-30).

## Context

Every MetaObjects port models `extends` as a **super-reference, not a flatten**: inherited attributes and children physically live on the parent node, reachable only through the *resolving* accessors that walk the super chain. Each port also exposes *own-only* accessors that read the local node alone.

A serious, latent, cross-port bug class was found: reading a field/node's **effective** semantic property — or iterating its member set — through an **own-only** accessor silently drops everything inherited via `extends`. The trigger was Kotlin `field.isArrayType()` reading `isArray` own-only (a concrete field inheriting `isArray:true` from an abstract parent generated a scalar). An audit found the same shape across the framework: TS `meta-field.ts` getters, `naming.ts:resolveColumnName`, `migrate-ts/expected-schema` (schema drift), `runtime-ts` (BaseEntity PK, jsonb coercers), C# `field.IsArray`, and ~6 JVM sites including a Kotlin `filterIsInstance<RdbSource>()` source lookup that emits *nothing* for an entity inheriting its source. The gap stayed hidden because **no conformance fixture exercises abstract-field-`extends` for any property except enum `@values`** — which is exactly the one property that got a resolving accessor.

## Decision

**Resolving/effective accessors are the default, everywhere. `own*()` is a rare, deliberately-commented exception with essentially one legitimate reason.**

### The one legitimate use of `own*()`
**Codegen emitting a generated class that `extends` a generated base**, iterating **own members** (`ownFields()`/`own_fields()`/`OwnChildren()`) so inherited members are **not re-emitted** — the generated base class already declares them (the `class Sub extends Base` / TPH pattern). Pinned by `test_entity_model.py` ("id … inherited; not re-emitted (own_fields only)").

Two metamodel-internal siblings use the same *"emit only the declared-here layer"* principle and are also legitimate:
- **The own-mode canonical serializer** (`canonicalSerialize`, not `…Effective`) — round-trips the *authored* form so re-loading reconstructs the same `extends` tree. (The *effective* serializer must resolve.)
- **Overlay/merge** and **super-resolution walks** — operate on declarations by definition.

### Everywhere else, `own*()` is a bug
- **Reading an effective value** (`isArray`, `subType`, `@maxLength`, `@precision`/`@scale`, `@default`, `@column`, `@objectRef`, `@storage`, `@valueType`, `@required`, `@currency`, `@autoSet`, `@stringFormat`, `@localTime`, relationship/identity/source attrs, …) → **resolve**. A property may be inherited through the node's own `extends` chain.
- **Iterating members for runtime, validation, effective serialization, schema building, or extract** → resolve (`fields()`/`children()`/`attrs()`), because you need the *effective* set including inherited members.
- **"Root scans that only work because root is never extended"** (`root.OwnChildren()`) → still resolve. Working-by-accident is the fragile pattern this ADR eliminates.

### The physical exception
`@dbColumnType` is **never inherited** by explicit policy (a physical column-type override is not a logical property). It stays own-only, documented as such at the read site. This is the *only* attribute deliberately read own-only outside the emit-declared-here cases.

### Naming
Where a port's default-named accessor is own-only (Python `attr()` is own; TS `attr()` resolves — an inversion), the port SHOULD make the **resolving** form the default-named one and the own form explicitly `own*`, so "the obvious call" is the correct one. Any `own*()` call MUST carry a one-line comment stating which sanctioned case it is.

## Consequences

- A concrete field/entity that `extends` an abstract parent now correctly inherits its properties and members through codegen, runtime, serialization-effective, schema, and validation — in all five ports.
- A **conformance fixture** (abstract field with `isArray`/`maxLength`/`precision`/`default`/`objectRef`/`storage` + a concrete field that `extends` it, plus an entity-level BaseEntity case) gates the class permanently; it fails on pre-fix code.
- The rule is propagated to CLAUDE.md and the agent-context authoring/codegen/audit skills; the `metaobjects-audit` skill flags own-accessor value-reads/effective-iteration in codegen/runtime as a defect.
- Each remaining `own*()` call is either the sanctioned emit-declared-here case (commented) or `@dbColumnType` (commented) — any other is a bug.

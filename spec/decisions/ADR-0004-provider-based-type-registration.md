# ADR-0004 — Provider-based type registration & composition

**Status:** Accepted — 2026-05-23
**Applies to:** all language ports (TS, Java, Python, C#)
**Related:** ADR-0002 (Open-Closed typed nodes), ADR-0003 (constants colocation),
ADR-0001 (metadata→native-type *binding*, a distinct concern);
`docs/superpowers/specs/2026-05-21-metadata-constants-colocation-design.md`;
`spec/cross-language-porting-guide.md`

## Context

The loader needs a **type registry**: a map from `(type, subType)` to a definition
(factory, attribute schema, child rules, coarse datatype) that the parser consults to
construct the right node class and that validation consults for attribute rules. The
question is *how that registry is populated* — in a way that is Open-Closed (ADR-0002),
respects colocation (ADR-0003), and lets independently-developed slices contribute types
without editing a central registration function.

A single central `registerAllTypes()` fails the same way a god constants file does: every
new subtype edits one ever-growing function, and a downstream package can't add a genuinely
new (non-core) metamodel type without modifying the core.

Industry precedent for composable, self-registering type systems: Protobuf's `TypeRegistry`
populated by generated self-registration; gRPC's per-service registration composed at
startup; SQLAlchemy's `registry` populated by both declarative and imperative mapping;
Java's `ServiceLoader` SPI. ADR-0001 already adopts this composition model for
metadata→native binding; this ADR applies the same shape to *metamodel type registration*.

> **Distinction from ADR-0001.** ADR-0001 is about binding a metadata FQN to a *native
> class/module* at codegen/runtime time. **This ADR** is about registering metamodel
> *subtypes* into the loader's type registry at load time. Both use a provider/composition
> model; they operate at different layers and must not be conflated.

## Decision

**Types are registered via composable providers, not a central registration function.**

The durable cross-language contract:

1. **A `MetaDataTypeProvider` abstraction** with a stable `id`, optional `dependencies`
   (other provider ids), and a `registerTypes(registry)` operation.
2. **`composeRegistry(providers)`** topologically sorts providers by dependency and invokes
   each in order, producing the populated registry. Duplicate ids, missing dependencies, and
   dependency cycles are errors with stable codes.
3. **The core metamodel ships as the core provider(s)** (a `metaobjects-core-types`
   provider; persistence-domain attrs as a dependent provider). The seam exists from day one
   even when only the core provider is present — *the seam is the extensibility contract.*
4. **Discovery/registration mechanism is idiomatic per language** (Tier-2), but the
   provider contract (id, dependencies, `registerTypes`, topo-sorted composition) is
   invariant:

   | Language | Subtype self-registration | Provider discovery / composition |
   |---|---|---|
   | **Java** | static `registerTypes(registry)` per class | one `MetaDataTypeProvider` per package, auto-discovered + dependency-sorted via `ServiceLoader` (SPI) |
   | **TS** | per-concern registration; attr subclasses self-register into a dependency-free class map (breaks a module-eval cycle) | explicit `composeRegistry([...])`; one composed `coreTypesProvider` |
   | **Python** | decorator self-registration onto a domain provider (`@provider.register`) | explicit `compose_registry([...])`; entry-point discovery is a documented future extension that does not change the seam |
   | **C#** | (stale) central registration | to migrate onto the provider model when next touched |

5. **Registry-level attribute inheritance** (`inheritsFrom(type, subType)`) is supported so a
   subtype need not re-declare its base's attributes — reinforcing ADR-0002's low
   per-subtype cost.

## Consequences

**Positive**
- Open-Closed at the registration layer: a new subtype self-registers; a genuinely new
  (non-core) metamodel type ships as a *new provider* with a dependency on core — zero edits
  to the core registration.
- Composable across independently-developed slices (the same property ADR-0001 relies on).
- Deterministic load order via topological sort, independent of file/import order.
- The single core provider keeps the common case simple while the seam stays open.

**Negative / costs**
- A registry + provider abstraction + a topo-sort is a one-time investment per port.
- Self-registration depends on the subtype's module being imported. Each port handles this
  idiomatically (Java SPI; TS side-effect imports; Python concern-package `__init__`
  importing its subtypes). The porting guide documents the per-language hazard.

## Alternatives considered (rejected)

1. **Central `registerAllTypes()`.** Not Open-Closed; a downstream package can't add a type
   without editing the core. Rejected.
2. **Pure reflection/scanning to discover types.** AOT/native-image-hostile (see ADR-0001),
   impossible in TS, and nondeterministic ordering. Rejected as the universal mechanism.
3. **Per-concern providers everywhere (fragment the core into N providers).** Per-concern
   *modules* (ADR-0003) already deliver locality; minting N providers adds composition
   ceremony without a consumer that needs to toggle concerns independently. Keep one composed
   core provider; split later only if a headless consumer needs to drop a layer.

## Realization status

- **Java** — shipped: per-package providers via `ServiceLoader`, dependency-sorted. Reference.
- **TS** — shipped: `MetaDataTypeProvider` + `composeRegistry`; one composed core provider
  (plus a db provider). Attr subclasses self-register via a dependency-free class map.
- **C#** — **stale**: central registration; migrate onto the provider model when next touched.
- **Python** — adopting from the start: decorator self-registration + explicit
  `compose_registry`; single core provider for the loader+conformance milestone; entry-point
  discovery deferred (no consumer needs it yet, and no fixture exercises multi-provider
  composition).

## Conformance note

Which provider registers a type, and in what mechanism, is invisible to the corpus —
conformance tests the canonical *output* and the loader's *observable* errors/warnings. The
provider *error codes* (`ERR_PROVIDER_*`) are part of the stable error vocabulary but are
not exercised by current fixtures (all use the single core provider); they remain defined so
a future multi-provider fixture can pin them identically across languages.

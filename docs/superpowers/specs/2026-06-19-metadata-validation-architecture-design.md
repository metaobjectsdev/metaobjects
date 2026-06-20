# Sophisticated metadata validation — a normalized, provider-extensible architecture

_2026-06-19. Triggered by a cross-reference gap (a dangling `relationship.@objectRef` /
`identity.reference.@references` loaded silently). The narrow fix shipped on PR #44; this
doc is the architecture for **sophisticated, extensible, cross-port-consistent** metadata
validation — especially cross-references — that the gap exposed the need for._

## The problem, framed correctly

Loading metadata is a **compiler front-end**, not a schema check:

```
parse (per file) → merge/overlay → [ build symbol table → resolve refs → semantic checks ] → freeze
                                    └──────────────── "semantic analysis" ────────────────┘
```

Two classes of check, with different needs:

1. **Local / structural** — decidable from one node: required attrs, enum membership,
   `@kind` values, value coercion, child placement.
2. **Global / relational** — decidable only against the *whole loaded tree*: `@objectRef`,
   `@references`, `extends`, `@payloadRef`, origin `@from/@of/@via`. These are
   **name-resolution** problems — a node alone cannot answer them; you need an index of
   every object/field first.

Two hard requirements emerged in design:

- **R1 — cross-references must be first-class** (the bug): resolution against a symbol
  table, target-kind enforced, present *and future* reference kinds covered.
- **R2 — downstream-extensible** (the load-bearing one): an adopter that registers **new
  types/subtypes via a new provider** must be able to **validate them** — including complex
  imperative rules — without forking core. This must work **identically in every port**.

R2 is what eliminates most of the option space.

## What the field does (research)

- **TypeScript compiler** (we're TS-first): strict two-phase split — the **binder** builds
  a **symbol table**; the **checker** resolves names against it. Cross-file merge = a
  **merged-symbols table** (= our overlay/merge). Logic lives in the binder/checker, **not**
  on AST nodes. ([binder notes](https://github.com/microsoft/TypeScript-Compiler-Notes/blob/main/codebase/src/compiler/binder.md))
- **GraphQL / Crystal**: validation is a **visitor running a rule set**; multi-pass.
  ([GraphQL validation](https://medium.com/@cjoudrey/life-of-a-graphql-query-validation-18a8fb52f189))
- **Smithy** (AWS — a model standard we benchmark): a **registry of validators** matched by
  **selectors**, emitting **events** with severity + location; custom validators are
  **declarative, no code**. ([model validation](https://smithy.io/2.0/spec/model-validation.html))
- **XSD `keyref`** = limited *declarative* referential integrity; **JSON Schema is
  context-free** — referential integrity is *explicitly out of scope*. ([scope](https://github.com/json-schema-org/json-schema-spec/wiki/Scope-of-JSON-Schema-Validation))
- **SHACL** (W3C): fully declarative shapes; **parameterised constraints** are where "a
  validation checklist crosses into a type system." ([parameterised constraints](https://ontologist.substack.com/p/shacls-hidden-superpower-parameterised))

**Lessons:** build a symbol table before resolving refs; the *most extensible* systems make
checks **registered + data-driven** (Smithy/SHACL), so new vocabulary validates without core
changes — which is precisely R2.

## The dead ends (and why)

- **Node-self-validation via class overrides (`MetaRelationship.validate()`).** Appealing
  OO, and fine *in Java/C#*. But it **fails R2 in TS/Python**: those ports have a single
  generic `MetaData` (no per-type subclass), so a downstream type has no class to hang a
  method on, and core's `switch(type)` can't be extended by an adopter. Per-port split
  (Java overrides / TS functions) also makes the *adopter's* extension experience differ by
  port — unacceptable for a cross-language standard.
- **Hardcoded procedural pass list (status quo).** What all five ports do today
  (`ValidationPhase`, `validation-passes`, …). Also **fails R2**: the pass list lives in the
  loader; a provider cannot add a pass. (It *does* already enforce *declarative* registry
  constraints — required attrs, enum, child placement — on custom types; that part is fine.)

## The architecture: a normalized **validator registry**

One model, all five ports. The unit of validation is a **validator registered with a
`(type, subType)` by the provider that defines it** — the same registration that already
carries the type's attrs/constraints/`maxOccurs`. Two tiers:

1. **Declarative rules** (data, in the provider spec) — applied generically by core to *any*
   registered type. The new piece is a **reference descriptor**: an attr declares *what it
   points at*.

   ```jsonc
   // a provider's type spec — relationship.composition
   { "attrs": [
       { "name": "objectRef", "valueType": "string",
         "reference": { "target": "object", "dottedFieldPath": false } } ] }
   ```

   A **single generic reference resolver** reads these and resolves every `reference` attr
   against the symbol table — `@objectRef` / `@references` / `@payloadRef` / future kinds,
   uniformly, target-kind enforced. (XSD `keyref` / Smithy selectors, adapted.)

2. **Imperative validators** (code) for logic config can't express — a function registered
   per `(type, subType)`, invoked by the recursive walk.

**Dispatch is uniform; the validator *body* is idiomatic per port.** Core's
`root.validate(ctx)` walks the tree and, per node: *apply declared rules (incl. reference
descriptors) → invoke `registry.validatorFor(type, subType)` → recurse.*

```java
// Java/C#: the validator is a METHOD REFERENCE — logic lives on/by the typed class,
// uses its typed accessors; dispatch is via the registry (uniform + extensible).
registry.registerValidator(TYPE_RELATIONSHIP, SUBTYPE_COMPOSITION, MetaRelationship::validateNode);
static void validateNode(MetaData node, ValidationContext ctx) {
    var rel = (MetaRelationship) node;
    if (rel.isM2M() && countJunctionRefs(ctx.symbols().resolveObject(rel.getThrough())) != 2)
        ctx.error(ERR_INVALID_RELATIONSHIP, rel, "...");
}
```
```ts
// TS/Python: same architecture, body as a closure (no subclass needed).
registry.registerValidator(TYPE_RELATIONSHIP, SUBTYPE_COMPOSITION, (node, ctx) => { ... });
```

**This satisfies R2 by construction:** a downstream provider registers `type + reference
descriptors + validator` as one unit; its custom types validate the same way in every port,
no core fork. "The metadata validates itself" holds — *"itself"* is the **type**, and a
type's validator is a **registered capability** (a method-ref in the OO ports, a closure in
the data-oriented ports), not a hardcoded core pass.

### Keep the typed node classes

Java/C# keep `MetaRelationship` / `ReferenceIdentity` etc. — they're the home of
construction + typed accessors (`getObjectRef()`, `getTargetEntity()`), which the validator
methods *use*. Only validation **dispatch** normalizes onto the registry; we are **not**
ripping out the OO node model.

### One divergence to normalize alongside: the error model

Java currently **eager-throws** on the first error; TS/Python/C# **collect** into an
envelope. The registry's `ValidationContext.error(...)` is the place to unify this — switch
Java to **collect** so a load reports *all* problems (better UX; matches the other ports).
Deliberate behavior change (conformance envelopes gain multi-error cases), decided as part
of this work.

## Cross-port shape

| Port | Node model | Validator body | Dispatch | Reference descriptors |
|---|---|---|---|---|
| Java | typed subclasses | static method ref | **registry** | on attr def (`TypeDefinition`) |
| C# | typed subclasses | static method ref | **registry** | on `AttrSchema` |
| Kotlin | (shares JVM metadata) | — | — | — |
| TS | generic `MetaData` | closure | **registry** | in provider data |
| Python | generic `MetaData` | closure | **registry** | in provider data |

Same registry, same recursive `root.validate(ctx)`, same declarative reference descriptors;
behavior conformance-locked. The adopter's extension story is **identical** everywhere.

## Recommendation & phasing

Adopt the **validator registry + declarative references + recursive `root.validate(ctx)`**
in all five ports.

- **Phase 1 (shipped, PR #44):** `@objectRef` / `@references` enforcement as procedural
  passes + the two conformance fixtures. Closes the bug now.
- **Phase 2 (this branch — prototype):** introduce `SymbolTable`, `ValidationContext`,
  `ReferenceDescriptor`, and a `ValidationRegistry`; route the reference checks through a
  **generic reference resolver**; prove **downstream extension** with a fake external
  provider registering a custom type + reference + imperative validator. Built in **TS +
  Java** as a vertical slice to de-risk the shape.
- **Phase 3:** migrate the remaining bespoke resolvers (`extends`, `@payloadRef`, origins)
  onto reference descriptors; wire validator/descriptor registration through the
  `MetaDataTypeProvider` SPI in every port; normalize the error model (Java → collect);
  port the slice to C#/Python; add a downstream-extension conformance fixture.
- **Phase 4 (optional, demand-driven):** formal severities; a thin declarative rule surface
  (SHACL-style) only if enterprise custom-rule authoring demands it.

## Prototype acceptance (Phase 2, this branch)

- A reference attr resolves generically (no bespoke pass) → dangling target = error,
  target-kind mismatch = error.
- A **fake downstream provider** registers `widget.gauge` with a `feeds` reference + an
  imperative range validator; a model with a bad `feeds` ref **and** a bad range produces
  **both** errors — in **TS and Java**, via the same registry mechanism, with **no core
  edits** for the custom type.
- Existing conformance stays green (behavior-preserving for the built-in reference checks).

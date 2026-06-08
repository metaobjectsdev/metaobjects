# FR-021 — Cross-port package-binding codegen config

**Status:** Design (ready for implementation)
**Created:** 2026-06-08
**Relates to:** [ADR-0001](../../../spec/decisions/ADR-0001-cross-language-type-binding.md) (per-port type binding is codegen config, not metadata), [ADR-0026](../../../spec/decisions/ADR-0026-shared-and-provided-named-types.md) §3 (`@csEnumType` retired in favor of codegen config), [FR-019](2026-06-06-fr-019-shared-and-provided-enums-design.md) (introduced C# `PackageNamespaces` for `@provided` enums — this FR generalizes that shape)

## Why this doc exists

FR-019 introduced the C# `GenConfig.PackageNamespaces: Dictionary<string,string>` map and a single `ProvidedEnumNamespace` fallback **scoped to `@provided` enums only**. That map is exactly the right primitive — bind a metadata package (`acme::cases`, `acme::domain::dataEnums::authorizations`) to a per-port output identity (a C# namespace, a TS module specifier, a Java package, …). Three gaps in the current shape:

1. **It's only wired for `@provided` enums.** The same primitive should govern where entities and value-objects land in each port's emitted output. The pattern is identical; only the consumer differs.
2. **Only the C# port has it.** TS has a single `providedEnumModule` string with no map; Java and Python have nothing. Cross-port symmetry is missing.
3. **No convention-based fallback.** Today every package needs an explicit entry. For an adopter with 18+ domains, that's 18 lines of overrides for a rule that says "strip the `acme::` prefix, prepend `Acme.Domain.Entities`, PascalCase the segments." Convention rules should cover the 90% case; the explicit map handles exceptions.

Per ADR-0001, all of this **stays in per-port codegen config** — none of it lives as metadata attrs. The retired `@csEnumType` was the wrong shape precisely because it baked C# vocabulary into language-agnostic metadata.

## Scope

1. Generalize per-port package binding from "where do `@provided` enums import from" to "where does this package land in this port's output" for every named type (entity, value object, abstract enum, projection, callable).
2. Add a **convention rule** primitive — strip + prepend + separator + case — that derives a target from a metadata package without an explicit map entry.
3. Cross-port symmetry: TS, Java, Python, Kotlin gain the same primitive shape (per-port idiomatic names; see naming section).
4. Conformance fixtures pinning the resolution order and at least three rule shapes (PascalCase-with-dots / kebab-case-with-slashes / lowercase-with-dots).

Out of scope: replacing how each port today *uses* its bound namespace (the `using` directives in C#, `import` statements in TS, `package` declarations in Java); those mechanics are unchanged.

## Naming (per-port idiomatic terms)

Each language has its own term for "where this lands." The cross-port config uses each port's idiomatic name within its port-scoped section — not a single shared term:

| Port | Section | Field | Example value |
|---|---|---|---|
| **C#** | `csharp:` | `namespace` | `Acme.Domain.Entities.Cases` |
| **Java** | `java:` | `package` | `com.acme.app.cases` |
| **Kotlin** | `kotlin:` | `package` | `com.acme.app.cases` |
| **TS** | `typescript:` | `module` | `@acme/app/cases` |
| **Python** | `python:` | `module` | `acme.app.cases` |

Rationale: a Java developer reading `java: { package: ... }` sees their language's term, not `javaPackage`. The port section already carries the language identity; doubling it as a key prefix is redundant. The retired `@csEnumType` attr was wrong for the *opposite* reason — it carried language vocabulary into metadata where it didn't belong.

## Config shape (per port)

The same primitive shape across all ports; only the field name (`namespace` vs `package` vs `module`) differs:

```yaml
# C# example
csharp:
  namespace:
    # CONVENTION RULE — applied to every metadata package that doesn't have
    # an explicit override entry. Stripped/derived prefix + prepended base +
    # case + separator.
    convention:
      strip: "acme::"                                       # prefix to remove from the metadata package
      prepend: "Acme.Domain.Entities"    # prefix to prepend to the derived segments
      separator: "."                                       # how to join package segments (lang-idiomatic)
      case: PascalCase                                    # PascalCase | camelCase | kebab-case | snake_case | lowercase | preserve

    # OVERRIDES — explicit map; beats the convention rule. Use when a single
    # metadata package binds to a target that the convention can't derive.
    overrides:
      "acme::reporting": "Acme.Domain.Entities.ReportEntities"
      "acme::domain::dataEnums": "Acme.Domain.DataEnums"
      "acme::domain::dataEnums::authorizations": "Acme.Domain.DataEnums.Authorizations"

    # FALLBACK STRATEGY — what to do for a metadata package that matches
    # neither an override nor the convention rule (e.g. the package doesn't
    # start with `strip`).
    unmappedStrategy: error    # error | flatten | derive
```

### Resolution order (Tier 1 — invariant across ports)

Resolution is **per named type**, not per package. The resolver receives `(metadataPackage, typeName)` and returns the target identity. Most types resolve via their package, but explicit per-type overrides win when set.

1. **Type-level override first.** If `typeOverrides["<pkg>::<typeName>"]` exists, use it verbatim. Lets a single entity / value-object / enum in an otherwise-uniform package land in a different namespace from its siblings (a real case — "4 things in this package go to A, 1 goes to B").
2. **Package-level override.** If `overrides[pkg]` exists, use it verbatim.
3. **Convention rule.** If the metadata package starts with `convention.strip`, apply the rule (algorithm below).
4. **Unmapped strategy.**
   - `error` — codegen fails with a clear message naming the package + the config key to set.
   - `flatten` — fall back to the port's default flat output namespace (e.g. C#'s `ctx.Config.Namespace`). Today's behavior when `PackageNamespaces` has no entry.
   - `derive` — apply the convention rule's case + separator transformation without `strip`/`prepend` (pure passthrough). Useful when metadata packages are already in the port's idiom.

### Convention rule algorithm (the `::` → `.` question, explicit)

`::` is always the **metaobjects-standard package separator** in metadata (cross-port invariant). The convention rule splits on `::`, transforms per-segment, and rejoins with the port-idiomatic separator. Step-by-step on `acme::users-access`:

| Step | Operation | Result |
|---|---|---|
| 1 | Input metadata package | `acme::users-access` |
| 2 | If starts with `convention.strip` (`acme::`), remove it | `users-access` |
| 3 | Split by `::` (the metaobjects separator) | `["users-access"]` |
| 4 | Apply `convention.case` to each segment (PascalCase) | `["UsersAccess"]` |
| 5 | Join segments by `convention.separator` (`.`) | `UsersAccess` |
| 6 | Prepend `convention.prepend` + `convention.separator` | `Acme.Domain.Entities.UsersAccess` |

Multi-segment example, `acme::cases::custom-properties`:
| Step | Result |
|---|---|
| Strip `acme::` | `cases::custom-properties` |
| Split by `::` | `["cases", "custom-properties"]` |
| PascalCase each | `["Cases", "CustomProperties"]` |
| Join by `.` | `Cases.CustomProperties` |
| Prepend base | `Acme.Domain.Entities.Cases.CustomProperties` |

The metadata separator (`::`) is **never** configurable — it's part of the metaobjects spec. The convention rule's `separator` is the per-port output joiner: `.` for C#, `/` for TS module paths, `.` for Java packages, etc.

### Per-type overrides — "4 things in one package, 1 goes elsewhere"

When a package contains entities that should mostly land in one namespace except for a few exceptions, use `typeOverrides`. Keyed by the **fully-qualified type name** (`<package>::<typeName>`) so resolution is unambiguous:

```yaml
csharp:
  namespace:
    convention: { strip: "acme::", prepend: "Acme.Domain.Entities", separator: ".", case: PascalCase }
    overrides:
      "acme::reporting": "Acme.Domain.Entities.ReportEntities"
    typeOverrides:
      # Most acme::lookups types land in .Entities.Lookups via the convention,
      # but Currency is a top-level concept owned elsewhere in the codebase.
      "acme::lookups::Currency": "Acme.Domain.Shared"
      # Authorization's value-objects live in the Dto namespace by P3 convention,
      # while the entities live in the Entities namespace.
      "acme::authorizations::InsuranceParameters": "Acme.Domain.Dto"
```

Resolution checks `typeOverrides` first, then `overrides`, then the convention rule. The type-level override wins absolutely — its target is used verbatim, no further transformation.

### `@provided` enum routing (sub-knob on the convention rule)

The one differential-routing case that consistently shows up in real C# adopters is FR-019 abstract `field.enum` declarations with `@provided: true` — these are referenced (not generated) and very often live in a parallel namespace tree from their consuming entities (e.g. `Acme.Domain.DataEnums.*` vs `Acme.Domain.Entities.*`).

Rather than a general kind-based predicate engine (which would need to grow to cover compound rules like "field.enum AND abstract AND @provided" and would explode combinatorially as new metadata kinds appear), the convention rule grows one focused knob:

```yaml
csharp:
  namespace:
    convention:
      strip: "acme::"
      prepend: "Acme.Domain.Entities"     # entities, VOs, etc. land here
      providedEnumPrepend: "Acme.Domain.DataEnums"   # @provided enums land here
      separator: "."
      case: PascalCase
```

When the resolver is on the `@provided` enum path (the FR-019 shared-enum reference case), `providedEnumPrepend` swaps in for `prepend`; everything else about the convention (strip / case / separator / segment-append) stays identical. Unset = `@provided` enums land alongside entities under the same `prepend`.

Two host-language APIs let consumers signal which path they're on:
- `Resolve(...)` — default path, uses `prepend`
- `ResolveForProvidedEnum(...)` — used only by the FR-019 `field.enum` reference emitter, uses `providedEnumPrepend`

Resolution order on either path:
1. `typeOverrides["<pkg>::<typeName>"]` — wins absolutely
2. `overrides[pkg]` — package-level (skipped on the `@provided` enum path; package-level overrides target entity placement, not enum placement)
3. `convention` rule — using `prepend` or `providedEnumPrepend` per path
4. (port-level legacy fallback, e.g. FR-019's `providedEnumNamespace` single-string)
5. `unmappedStrategy`

Adopters whose `@provided` enums are FLAT in a single namespace (no per-package sub-tree) skip `providedEnumPrepend` entirely and use the FR-019 single-string `providedEnumNamespace` fallback + `typeOverrides` for sub-namespace exceptions. This is exactly what the P3 C# adopter does (see worked example below).

**Why not a general rule/predicate engine.** We explicitly chose NOT to add `perKindOverrides`, `rules: when {}`, or a `NamedKind` enum. Reasons:
- `NamedKind` would be a closed set of values the framework knows about today; metadata kinds grow over time and the enum would need amendments + a new release every time a new kind appears.
- Compound predicates (`kind=field.enum AND abstract AND @provided`) don't fit cleanly into a single enum; they need a predicate DSL, which is heavy machinery for one well-known case.
- The one routing dimension that's actually been hit in practice is `@provided` enum reference resolution — that single named knob covers it. Future routing splits, if they materialize, can earn their own named knobs the same way.

### Case transformation table

| Convention `case` | `acme::user-access` (segment `user-access`) | Result |
|---|---|---|
| `PascalCase` | → `UserAccess` | C# namespace segment |
| `camelCase` | → `userAccess` | TS module path segment |
| `kebab-case` | → `user-access` | TS package name segment |
| `snake_case` | → `user_access` | Python module segment |
| `lowercase` | → `useraccess` | Java package segment (no separator within a segment) |
| `preserve` | → `user-access` | as-authored |

`case` applies **per segment**, after splitting by `::`. The `separator` then joins segments using the port-idiomatic delimiter.

### Worked examples

**P3 C# adopter** (the driving case — `@provided` enums live FLAT in `DataEnums`, with 12 sub-namespace exceptions):
```yaml
csharp:
  namespace:
    convention:
      strip: "acme::"
      prepend: "Acme.Domain.Entities"
      separator: "."
      case: PascalCase
    overrides:
      # Entity-side overrides
      "acme::reporting": "Acme.Domain.Entities.ReportEntities"
      # Collision avoidance — `Entities.Workflow` shadows the `Workflow` type,
      # `Entities.System` shadows the BCL `System` namespace.
      "acme::workflow": "Acme.Domain.Entities.WorkflowDomain"
      "acme::system":   "Acme.Domain.Entities.SystemDomain"
    providedEnumNamespace: "Acme.Domain.DataEnums"   # FR-019 single-string fallback
    typeOverrides:
      # The 12 @provided enums that live in DataEnums sub-namespaces
      "acme::authorizations::AuthorizationType":      "Acme.Domain.DataEnums.Authorizations"
      "acme::authorizations::AuthorizationStatus":    "Acme.Domain.DataEnums.Authorizations"
      "acme::authorizations::CopayCardStatus":        "Acme.Domain.DataEnums.CopayCards"
      # ... 6 more Copay* enums in acme::authorizations
      "acme::integrations::DataExportRunStatusEnum":  "Acme.Domain.DataEnums.DataExportIntegration"
      "acme::integrations::SPFileType":               "Acme.Domain.DataEnums.SPIntegration"
      "acme::integrations::SPProcessLogStatus":       "Acme.Domain.DataEnums.SPIntegration"
    unmappedStrategy: error
```

Resolves:
- `acme::cases` → convention → `Acme.Domain.Entities.Cases`
- `acme::users-access` → convention → `Acme.Domain.Entities.UsersAccess`
- `acme::reporting` → override → `Acme.Domain.Entities.ReportEntities`
- `acme::patients::Gender` (provided enum) → `providedEnumNamespace` → `Acme.Domain.DataEnums.Gender`
- `acme::authorizations::AuthorizationType` (provided enum) → `typeOverrides` → `Acme.Domain.DataEnums.Authorizations.AuthorizationType`

~18 entries instead of ~80 — convention covers 13 entity packages, 3 entity overrides, the `providedEnumNamespace` single-string fallback covers ~51 flat enums, and 12 `typeOverrides` pin the sub-namespace exceptions.

**Hypothetical Acme C# adopter** (parallel `DataEnums.*` tree mirroring entity tree):
```yaml
csharp:
  namespace:
    convention:
      strip: "acme::"
      prepend: "Acme.Domain.Entities"
      providedEnumPrepend: "Acme.Domain.DataEnums"  # parallel namespace tree
      separator: "."
      case: PascalCase
    unmappedStrategy: error
```

Resolves:
- `acme::orders::Order` (entity) → convention with `prepend` → `Acme.Domain.Entities.Orders`
- `acme::orders::OrderStatus` (@provided enum) → convention with `providedEnumPrepend` → `Acme.Domain.DataEnums.Orders`

No overrides needed — the parallel namespace tree falls out of the convention.

**Hypothetical TS adopter** (same metadata, different idiom):
```yaml
typescript:
  module:
    convention:
      strip: "acme::"
      prepend: "@acme/app"
      separator: "/"
      case: kebab-case
    unmappedStrategy: derive
```

Resolves:
- `acme::cases` → `@acme/app/cases`
- `acme::users-access` → `@acme/app/users-access`

**Hypothetical Java adopter:**
```yaml
java:
  package:
    convention:
      strip: "acme::"
      prepend: "com.acme.app"
      separator: "."
      case: lowercase
    unmappedStrategy: error
```

Resolves:
- `acme::cases` → `com.acme.app.cases`
- `acme::usersaccess` → `com.acme.app.usersaccess`

## Per-port codegen surface

For each port that emits per-package output:

1. **Read the port's section** of the codegen config (`csharp.namespace`, `typescript.module`, `java.package`, `python.module`, `kotlin.package`).
2. **Resolve every named type's owning package** via the resolution order above.
3. **Emit the per-port output identity** wherever the port's existing emission references it — C# `namespace` declarations + `using` directives; TS `import` specifiers + module paths; Java `package` declaration; Python module attribute on the file.
4. **Today's `@provided`-enum resolution becomes one consumer** of the same primitive — not a special case.

Per-port file naming (`metaobjects.config.{ts,cs,yaml,...}`) is at each port's discretion; the **shape** is what's locked across ports.

## Where the config file lives

Each port reads it from a per-port file at the project root, in the port's native config format:

| Port | File |
|---|---|
| **C#** | `metaobjects.config.json` (or `.csproj` MSBuild item) read by `MetaObjects.Cli` and surfaced as `GenConfig` properties |
| **TS** | `metaobjects.config.ts` (already exists) — adds a `csharp:`-symmetric `typescript:` section |
| **Java** | `metaobjects-config.yaml` or Maven plugin config |
| **Python** | `metaobjects.config.yaml` or `pyproject.toml` `[tool.metaobjects]` |
| **Kotlin** | `metaobjects-config.yaml` |

The **schema** of each port's config (within its per-port section) is identical — `convention`/`overrides`/`unmappedStrategy` — but the file lives where each ecosystem expects.

## Conformance (Tier 5)

Add to `fixtures/conformance/` (per-port + cross-port):

- **`package-binding-convention-resolves-by-rule`** — metadata package `acme::sales::orders` + convention `{ strip: "acme::", prepend: "Acme.App", separator: ".", case: PascalCase }` resolves to `Acme.App.Sales.Orders`. Asserted per port using the port's idiomatic field name + separator/case.
- **`package-binding-override-beats-convention`** — same convention as above, but `overrides[acme::sales::orders] = "Acme.Legacy.OrderModule"` wins.
- **`package-binding-unmapped-error`** — `unmappedStrategy: error` + a package that matches neither rule nor override → codegen-time error with the package name + the config key to set.
- **`package-binding-unmapped-flatten`** — same setup, `unmappedStrategy: flatten` → fall back to the port's default flat namespace; no error.
- **`package-binding-case-transformations`** — each `case` value produces the expected segment shape (PascalCase / camelCase / kebab-case / snake_case / lowercase / preserve).
- **`package-binding-applies-to-entities-and-value-objects`** — not just `@provided` enums; the same resolution governs `object.entity` + `object.value` emission location.

The C# port's existing `PackageNamespaces` map + `ProvidedEnumNamespace` fallback are the **closest existing primitive** — this FR extends both into the generalized convention/overrides shape and adds per-kind reach.

## Realization status

- **C# port**: closest to done. Has the map shape today (`PackageNamespaces`) but no convention rule, no `unmappedStrategy`, and the map is only consumed by the `@provided`-enum resolver. Implementation order:
  1. Add `Convention` + `UnmappedStrategy` fields to `GenConfig` (companion to `PackageNamespaces`).
  2. Generalize the resolver to handle override → convention → fallback, expose as a single helper.
  3. Wire the resolver into `EmitMappedClass` / `EmitValueObjectPoco` so entity + VO emission honors the same map (today they go to `ctx.Config.Namespace` flat).
  4. Add conformance fixtures.

- **TS port**: has `providedEnumModule` (single string). Add `modules` map + convention + fallback; mirror the C# resolver. Wire into entity + payload emission.

- **Java / Python / Kotlin**: greenfield. Implement the config primitive and the resolver together per the conformance fixtures.

- **Adopter migration**: the existing C# `PackageNamespaces` entries remain valid as `overrides`. No breaking change for adopters who use only the map. Adding `convention` is opt-in. `ProvidedEnumNamespace` (single fallback string) maps cleanly to `unmappedStrategy: flatten` + the existing default-namespace mechanism.

## Cross-references

- [ADR-0001](../../../spec/decisions/ADR-0001-cross-language-type-binding.md) — bind metadata→native types at build time, per port (no FQN in metadata). This FR is the realization of that ADR for the "where does the type live" half.
- [ADR-0026](../../../spec/decisions/ADR-0026-shared-and-provided-named-types.md) §3 — language FQN-in-metadata rejected; per-port codegen config carries the namespace. This FR generalizes the binding from "@provided enums only" to all named types.
- [FR-019](2026-06-06-fr-019-shared-and-provided-enums-design.md) — introduced the C# `PackageNamespaces` map for `@provided` enum resolution. This FR extends that primitive uniformly across ports + kinds, and adds the convention-rule layer.

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

### Per-kind sugar (convenience, optional)

When all named types of a particular *kind* in a package should land in a different namespace, `perKindOverrides` is shorthand for stamping out N type-level overrides. Common case: value-objects → DTO namespace, lookups → Lookup namespace, projections → ReadModels namespace.

```yaml
csharp:
  namespace:
    convention: { ... }
    perKindOverrides:
      "acme::cases":
        valueObject: "Acme.Domain.Dto.Cases"
        lookup: "Acme.Domain.Entities.Lookup"
        # entity → convention rule (unchanged)
```

Resolution order with all three layers:
1. `typeOverrides["<pkg>::<typeName>"]` — most specific, wins everything
2. `perKindOverrides[pkg][kind]` — applies to all named types of `kind` in `pkg`
3. `overrides[pkg]` — applies to all named types in `pkg` regardless of kind
4. `convention` rule
5. `unmappedStrategy` fallback

`kind` values: `entity`, `valueObject`, `enum`, `lookup`, `projection`, `callable`, `tphSubtype`. (`lookup` is heuristic — a `field.string`-keyed entity with no outgoing FKs; ports may choose to ignore the distinction.)

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

**P3 C# adopter** (the driving case):
```yaml
csharp:
  namespace:
    convention:
      strip: "acme::"
      prepend: "Acme.Domain.Entities"
      separator: "."
      case: PascalCase
    overrides:
      "acme::reporting": "Acme.Domain.Entities.ReportEntities"
      "acme::domain::dataEnums": "Acme.Domain.DataEnums"
      "acme::domain::dataEnums::authorizations": "Acme.Domain.DataEnums.Authorizations"
      "acme::domain::dataEnums::copayCards": "Acme.Domain.DataEnums.CopayCards"
      "acme::domain::dataEnums::dataExportIntegration": "Acme.Domain.DataEnums.DataExportIntegration"
      "acme::domain::dataEnums::spIntegration": "Acme.Domain.DataEnums.SPIntegration"
    unmappedStrategy: error
```

Resolves:
- `acme::cases` → convention → `Acme.Domain.Entities.Cases`
- `acme::users-access` → convention → `Acme.Domain.Entities.UsersAccess`
- `acme::reporting` → override → `Acme.Domain.Entities.ReportEntities`
- `acme::domain::dataEnums` → override → `Acme.Domain.DataEnums`

7 entries instead of ~20 — rule covers 13 packages, explicit overrides for the 6 non-conforming cases.

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

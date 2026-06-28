# SP-1 — Declarative Mustache template-generator parity (cross-port)

_Status: Proposed · 2026-06-28_

Part of the codegen authoring-parity program (the follow-on to ADR-0034
scaffold-and-own). Program order, decided with the user: **Mustache first (this
spec), then native-generator authoring parity (SP-2), then the agent-context docs
pass (SP-3).** Groovy is explicitly dropped — Mustache covers the "scriptable,
no-compile, cross-language" authoring need.

See also: [ADR-0034 (scaffold-and-own)](../../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md),
[ADR-0020 (codegen tiering — idiomatic-per-port vs neutral-shared)](../../../spec/decisions/ADR-0020-codegen-tiering-native-vs-neutral.md),
[the cross-port template-generator design (2026-05-28)](../../../spec/design-docs/2026-05-28-cross-port-template-generator.md),
[docs/features/codegen-concepts.md §3 (authoring menu) + §10 (scopes)](../../features/codegen-concepts.md).

---

## 1. Problem

Every port already ships the two codegen authoring **primitives**:

- a **native generator** interface (`Generator` / `IGenerator` / `GeneratorBase`),
- a **Mustache `TemplateGenerator`** factory whose render engine is byte-equivalent
  across all five ports (`fixtures/render-conformance/`).

What is **not** at parity is how a consumer wires their **own** Mustache-template
generator. Only TS has a config-is-code entrypoint where a consumer lists generator
instances and supplies a `walk` closure. The other ports drive codegen declaratively
(Maven XML, `--generators <names>` against a **sealed** registry) and cannot express a
code-defined walk:

| Port | Mustache template generator: consumer-usable today? |
|---|---|
| **TS** | ✅ `templateGenerator({ name, template, walk })` in `metaobjects.config.ts`; project `templates/` overrides framework defaults. |
| **Python** | ⚠️ `template_generator(...)` exists but **programmatic-only** (`run_gen(generators=[…])`); the CLI `--generators` resolves a hard-coded registry. |
| **Java** | ❌ cross-port `render/TemplateGenerator.generate(...)` exists + is conformance-gated, but is **not wired into the Maven plugin** — a consumer must hand-write a `Generator` wrapper class. Legacy `MustacheTemplateGenerator` is `@Deprecated`. |
| **Kotlin** | ❌ **no template generator at all** (KotlinPoet-only; Mustache deliberately omitted). |
| **C#** | ⚠️ `TemplateGenerator.Create(...)` factory exists, but the registry's CLI entry is a **no-op primitive** (empty template, in-memory empty provider) usable only for `--list`. Real use is programmatic. |

**Root cause:** the only thing stopping declarative use is that the **walk is code**.
If the common walks are *built-in and named*, a consumer can declare
`{ template, scope, outputPattern }` with **no code**, which every port's
declarative surface (Maven XML / CLI flag / config) can express.

## 2. Goal

A consumer authors a working code generator, on **any** port, with **no generator
code** for the common cases:

1. Drop a Mustache template in the project templates dir, e.g.
   `templates/service/entity-service.mustache`.
2. Declare a template generator in the port's own build/config surface:
   `template` (ref), `scope` (`perEntity` | `perPackage` | `wholeModel`),
   `outputPattern` (e.g. `"{package}/{name}Service.java"`), `format?` (escaper).
3. Run the port's normal gen verb.

A built-in **named scope walk** supplies a standard data dict to the template; the
output-pattern names each emitted file. This simultaneously lands the **`perPackage`**
scope helper that `codegen-concepts.md` §10 calls for (object + app scopes already
exist; package is the gap).

Walk-as-code (exotic walks beyond the three scopes) stays available where a port
already has it (TS), but is **not** the parity target and is **not** added to ports
that lack it. Native hand-written-generator registration is **SP-2**, not here.

## 3. The neutral contract (shared, byte-gated) — everything else is per-port

Per ADR-0020, the only cross-port-shared, conformance-gated artifacts are the four
below. Wiring, file I/O, and registration stay idiomatic per port.

### 3.1 Scope names (exact strings, all ports)

`perEntity` · `perPackage` · `wholeModel`

### 3.2 The template data dict per scope (the portable shape templates reference)

v1 — deliberately minimal but useful. Built from the loaded metadata; reuses the
existing docs data builder (`buildEntityDocData` and its peers) where possible so the
codegen template data model and the docs data model do not drift.

- **`perEntity`** → one file per concrete `object.entity` / projection:
  ```
  {
    name, package,
    fields: [ { name, type, required, isArray, maxLength?, enumValues? } ],
    identities: [ { kind, fields: [name…] } ],
    relationships: [ { name, cardinality, targetRef } ]
  }
  ```
- **`perPackage`** → one file per package: `{ package, entities: [ <perEntity dict> … ] }`
- **`wholeModel`** → one file total: `{ packages: [ { package, entities: [ <perEntity dict> … ] } ] }`

`type` is the **neutral metamodel field subtype** (`string`, `int`, `long`, `currency`,
`enum`, …) — NOT a language type. Templates that need a language type map it themselves
(that mapping is per-port and out of the neutral contract). Abstract entities and
non-instance shapes follow the same emit-eligibility rules the native generators use
(an abstract never emits an instance artifact).

The v1 dict deliberately omits views/origins/currency-locale/storage facets; those are a
fast-follow once v1 is gated (§6).

### 3.3 Output-pattern grammar (fixed, tiny)

Placeholders, expanded per walk unit: `{name}` (object name), `{Name}` (PascalCase),
`{package}` (package rendered as a path, `::` → `/`). `perPackage` patterns may use
`{package}`; `wholeModel` patterns are literal (no per-unit placeholder). Unknown
placeholder → hard error at gen time (no silent passthrough).

### 3.4 Template resolution

Project `templates/<ref>.mustache` overrides framework defaults via each port's existing
Provider chain — already byte-equal across ports, unchanged here.

### 3.5 The conformance corpus

New `fixtures/template-codegen-conformance/`: metadata + a small set of templates + a
manifest of `{ template, scope, outputPattern, format? }` specs + the expected emitted
files. **Every port runs it and must produce byte-identical output.** Because the render
engine is already conformance-equal, the only genuinely new gated surface is the
data dict (3.2) + scope walks (3.1) + output-pattern (3.3).

## 4. Per-port wiring (idiomatic; NOT a new shared config format)

Each port expresses the same spec in its own idiom. No new cross-port config file is
introduced — consistent with "each port runs codegen through its own build tool."

- **TS** (`@metaobjectsdev/codegen-ts`): `templateGenerator({ name, template, scope,
  outputPattern, format? })`. `scope` selects a built-in walk; the existing
  `walk` option stays for power users (mutually exclusive with `scope`). Reference
  implementation + the `perPackage` engine helper land here.
- **Java + Kotlin** (Maven plugin): a `<templateGenerator>` config element
  (`<template>`, `<scope>`, `<outputPattern>`, `<format>`) the plugin turns into a real
  `Generator` wrapping the cross-port `render/TemplateGenerator` + the named walk. **This
  is where Kotlin gains a template generator** — it is JVM and reuses the shared engine;
  no KotlinPoet involvement. Multiple `<templateGenerator>` elements allowed.
- **C#** (`dotnet meta`): a `--template-spec <file>` surface (JSON: an array of
  `{ name, template, scope, outputPattern, format? }`) — a CLI-only port, so the spec is
  a file, not a closure. Turns the no-op registry primitive into a real consumer-usable
  generator. (A `metaobjects.config`-style file is explicitly out of scope; ADR-0015 keeps
  C# CLI-flag-driven.)
- **Python** (`metaobjects gen`): the same `--template-spec <file>` surface as C#,
  replacing programmatic-only use.

The walk + data dict + pattern expansion is shared-by-contract (gated); the registration
surface is per-port.

## 5. Increment plan (each step conformance-gated)

Mirrors how cross-port features land in this repo — TS reference first, then fan out,
flipping the corpus on per port as it lands.

1. **SP-1a — TS reference.** Named scope walks (`perEntity`/`perPackage`/`wholeModel`)
   + the `perPackage` engine helper + `outputPattern` + data-dict builder, wired into
   `templateGenerator`. Author `fixtures/template-codegen-conformance/` and gate TS
   against it. (Lands the concepts-guide §10 `perPackage` gap.)
2. **SP-1b — JVM (Java + Kotlin).** Wire `<templateGenerator>` into the Maven plugin
   over the existing `render/TemplateGenerator`; implement the three named walks +
   data dict + pattern on the JVM; gate both Java and Kotlin against the corpus. Kotlin
   gains the template generator here.
3. **SP-1c — Python.** `--template-spec` surface + the walks/data-dict/pattern; gate.
4. **SP-1d — C#.** `--template-spec` surface + the walks/data-dict/pattern; gate;
   replace the no-op registry primitive.

Each increment is its own PR through the no-mistakes gate (tests run locally in an
isolated worktree; CI is the known-flaky `java-reactor` so it is not relied upon for
merge — admin-merge after local green, per the repo flow).

## 6. Out of scope (SP-1)

- **Native hand-written generator registration/selection parity** (registry mutation /
  SPI / stable-name selection of a consumer's own `Generator`, documented extension
  seams) — that is **SP-2**.
- **The agent-context docs rewrite** (teach the decision framework + own-your-generators
  on every port) — **SP-3**, written over the enhanced reality this program creates.
- **Consumer code walks beyond the three named scopes** — TS keeps its `walk` escape
  hatch; other ports do not gain one.
- **Richer data-dict fields** (views, origins, currency locale, storage facets, enum
  display labels) — a fast-follow once the v1 dict is gated.
- **Groovy** — dropped; Mustache covers the need.

## 7. Risks / open points

- **Data-dict scope creep.** v1 is intentionally thin. The gate makes additions cheap to
  verify but every field added is a cross-port obligation — add only on demonstrated need.
- **Reusing the docs data builder.** If the docs builder's shape is awkward for codegen,
  the codegen dict may need its own builder that shares helpers rather than the exact
  struct. Decide during SP-1a against the real fixture; do not force-fit.
- **`perPackage` naming.** The helper name (`perPackage`) and an optional `appLevel`
  alias for `oncePerRun` are cosmetic; confirm during SP-1a so all ports adopt the same
  scope strings.
- **C#/Python `--template-spec` ergonomics.** A JSON spec file is the lowest-risk
  declarative surface for the flag-driven ports; revisit only if it proves clumsy.

# Extending MetaObjects with providers

The metamodel is **open under composition**: every type, subtype, and attribute
the loader understands is contributed by a `MetaDataTypeProvider`. The core
package ships its own provider bundle (`metaobjects-core-types`,
`metaobjects-forge`, `metaobjects-documentation`), but the same mechanism is
how a downstream consumer adds an application-specific subtype — e.g., a
`template.toolcall` that the core doesn't know about.

This page covers:

- The provider contract (what a provider declares)
- How to register a new subtype or extend an existing one
- The cross-port semantic rules (explicit providers bypass ambient discovery)
- Stable error codes for composition failures

For a worked end-to-end walkthrough, see
[`../recipes/extending-metaobjects-with-providers.md`](../recipes/extending-metaobjects-with-providers.md).
For the cross-port API signatures, see each port's quickstart in
[`../ports/`](../ports/).

## The provider contract

A provider is the unit of metamodel composition. Every port exposes the same
four-member contract:

| Member | Required | Purpose |
|---|---|---|
| `id` | yes | Stable identifier (e.g. `"metaobjects-core-types"`). Conformance fixtures list providers by id; the duplicate-id error is keyed on this. |
| `dependencies` | no | IDs of providers that must register first. The loader topologically sorts before invoking `registerTypes`. |
| `description` | no | Free-text — surfaces in diagnostics. |
| `registerTypes(registry)` | yes | The body — calls `registry.register(...)` to add a new `(type, subType)` or `registry.extend(...)` to add attrs to an existing one. |

The dependency graph is enforced. A provider declaring a dep on an
unregistered id throws `ERR_PROVIDER_MISSING_DEPENDENCY`; a cycle throws
`ERR_PROVIDER_DEPENDENCY_CYCLE`; two providers reporting the same id throws
`ERR_PROVIDER_DUPLICATE_ID`. All three codes are stable across ports — see
[`../../fixtures/conformance/ERROR-CODES.json`](../../fixtures/conformance/ERROR-CODES.json).

## Two registration modes

### `register` — declare a new `(type, subType)`

Use when adding a subtype the core doesn't ship. A downstream consumer's
`template.toolcall` is the canonical example — `template` is a core type with
`prompt` and `output` subtypes registered by `metaobjects-core-types`; the
consumer adds `toolcall`.

```ts
import {
  type MetaDataTypeProvider,
  TYPE_TEMPLATE,
  TypeId,
  MetaTemplate,
  TYPE_ATTR,
  CHILD_RULE_WILDCARD,
  ATTR_SUBTYPE_STRING,
} from "@metaobjectsdev/metadata";

export const exampleToolcallProvider: MetaDataTypeProvider = {
  id: "example-template-toolcall",
  dependencies: ["metaobjects-core-types"],
  description: "Adds template.toolcall for LLM tool-use templates.",
  registerTypes(registry) {
    registry.register({
      typeId: new TypeId(TYPE_TEMPLATE, "toolcall"),
      description: "Template that emits an LLM tool-call envelope.",
      factory: (typeId, name) => new MetaTemplate(typeId, name),
      childRules: [{ childType: TYPE_ATTR, childSubType: CHILD_RULE_WILDCARD, childName: CHILD_RULE_WILDCARD }],
      attributes: [
        { name: "payloadRef", valueType: ATTR_SUBTYPE_STRING, required: true,
          description: "Tool-input payload value-object reference." },
        { name: "textRef",    valueType: ATTR_SUBTYPE_STRING, required: true,
          description: "Tool-call template body reference." },
        { name: "toolName",   valueType: ATTR_SUBTYPE_STRING, required: true,
          description: "Name of the LLM tool to invoke." },
      ],
    });
  },
};
```

### `extend` — add attrs to an existing `(type, subType)`

Use when the subtype already exists in core but you want a new domain-specific
attribute on it. The built-in `metaobjects-db` provider uses this to add
`@column` / `@db.indexed` to every `field.*` subtype, and `@table` / `@kind` /
`@role` / `@schema` to `source.rdb`:

```ts
registry.extend(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, {
  attributes: [...sourceRdbAttrs],
});
```

`extend` throws if the target `(type, subType)` was never registered — order
matters, which is why providers declare `dependencies`.

## Wiring providers into the loader

Each port has its own loader entry point. The contract is identical:
**provide an explicit list of providers, and the loader composes them in
dependency order, skipping any ambient discovery.**

```ts
// TypeScript
import { loadMemory } from "@metaobjectsdev/sdk";
import { exampleToolcallProvider } from "./codegen/providers";

const root = await loadMemory("./", {
  providers: [exampleToolcallProvider],   // composed AFTER core providers
});
```

```csharp
// C#
var loader = MetaDataLoader.FromDirectory("./metadata", registry);
// where `registry` is built via Provider.ComposeRegistry(providers)
```

```python
# Python
loader = MetaDataLoader.from_directory("./metadata", providers=[example_toolcall_provider])
```

```java
// Java — SPI auto-discovery is the default; META-INF/services lists every provider
// (no API call required). Programmatic compose() factory is a planned follow-up.
```

The semantic rule is identical across ports:

> **Explicit `providers` declarations bypass any ambient discovery.** The
> set you pass is exactly the set the loader composes. This guarantees
> determinism — same providers list + same metadata → same registry, no
> classpath order surprises, no bundler import-order surprises.

The TS / C# / Python loaders default to `[...coreProviders, forgeTypesProvider,
...callerProviders]` when the caller supplies `providers`. Pass
`{ replaceDefaults: true }` (TS) or the per-port equivalent to skip the
defaults entirely — rare, but supported.

## Stable error codes

Composition surfaces these codes consistently across all ports (see
[`../../fixtures/conformance/ERROR-CODES.json`](../../fixtures/conformance/ERROR-CODES.json)):

| Code | When | Conformance fixture |
|---|---|---|
| `ERR_UNKNOWN_TYPE` | YAML/JSON references a `type` not registered by any provider | (covered by core fixtures) |
| `ERR_UNKNOWN_SUBTYPE` | `type` is known but `subType` is not | `provider-extension-missing-provider-fails` |
| `ERR_PROVIDER_DUPLICATE_ID` | Two provider objects report the same `id` | `provider-extension-duplicate-id` |
| `ERR_PROVIDER_MISSING_DEPENDENCY` | Provider declares dep on an unregistered id | `provider-extension-missing-dependency` |
| `ERR_PROVIDER_DEPENDENCY_CYCLE` | Provider dependencies form a cycle | `provider-extension-dependency-cycle` |
| `ERR_PROVIDER_ATTR_CONFLICT` | Two providers declare the same attr on the same `(type, subType)` | (covered by negative tests in core) |

Each conformance fixture's `providers.json: string[]` lists the provider ids to
compose for that test — the same wire format consumers use at runtime. The
fixtures are run in every port (TS / C# / Python today; Java SPI version
forthcoming), so any future port automatically inherits the contract.

## When to write a provider vs. inline metadata

Use a provider when the new vocabulary applies across **multiple** metadata
files or **multiple** projects, and the semantics belong in the metamodel.
Don't write a provider for one-shot project-specific data — that's what
authored YAML / JSON metadata is for.

## When to add a subtype vs. an attr vs. an abstract

A provider can shape the metamodel three ways. Pick the lightest mechanism
that fits — every new subtype is a new line item in the cross-port registry,
in conformance tests, and in every consumer's mental model.

> This section is the *mechanics*. For the judgment layer — whether to model the
> concept at all, converging with core before inventing, and the design rules that
> make downstream vocabulary age well (protocol/address-free nodes, names-only
> fail-closed config, the register→extend→promote lifecycle) — see
> [downstream-metadata-decisions.md](downstream-metadata-decisions.md).

### Default: extend an existing subtype with attrs (`registry.extend`)

If the new concept is structurally identical to an existing subtype, only
adds configuration, and the existing subtype's required attrs ALL apply,
**extend the existing subtype with new attrs**. No new node class, no new
cross-port mapping, no new childRules.

Example — a `@audit-trail: true` flag on every `field.*` subtype, marking
columns whose changes get logged:

```ts
// "metaobjects-audit-trail" provider's registerTypes body:
for (const subType of FIELD_SUBTYPES) {
  registry.extend(TYPE_FIELD, subType, {
    attributes: [
      { name: "auditTrail", valueType: ATTR_SUBTYPE_BOOLEAN, required: false,
        description: "Log changes to this column in the audit-trail table." },
    ],
  });
}
```

YAML authors then write `field.string: { "@auditTrail": true }`. A custom
generator scans every field and emits audit-table wiring for those with
`@auditTrail: true`. **Same end result, zero new metamodel surface.** This
is exactly what the built-in `dbProvider` does to add `@column` and
`@db.indexed` to every field subtype.

**When extend doesn't fit:** if the existing subtype has REQUIRED attrs
that don't apply to your concept (e.g., `template.output` requires
`@textRef` for the renderable body, which a non-renderable tool-call
envelope doesn't have), escalation to a new subtype is honest. See the
escalation criteria below.

### When abstracts shine: reusable constraint sets via `extends`

If multiple metadata instances need the **same shape of constraints** that
should change together, declare an **abstract** instance and have concrete
fields reference it via `extends`. No provider code, no new subtype — just
authored metadata that other authored metadata inherits from.

`abstract` and `extends` are **structural keys** (bare, no `@` prefix) —
the same machinery that powers
[`entities.md § extends for shared abstract bases`](entities.md#extends-for-shared-abstract-bases).
The loader resolves `extends:` after all files load, so the abstract can
live in any file in the corpus.

Example — a short opaque slug identifier (URL-safe, fixed length, restricted
alphabet) that may appear on multiple entities:

```yaml
# metaobjects/abstracts/meta-slug-fields.yaml
metadata:
  package: yourpkg
  children:
    - field.string:
        name: shortSlug
        abstract: true
        "@maxLength": 8
        children:
          - validator.regex:
              "@pattern": "^[A-Z2-9]{8}$"
          - validator.required: {}
```

```yaml
# meta-council.yaml
- field.string:
    name: id
    extends: shortSlug
```

Codegen propagates the regex into the Drizzle CHECK constraint and the Zod
validator automatically. Change the alphabet in `shortSlug` once; every
field that extends it updates. **Zero new metamodel surface, zero
provider code.**

See [`abstracts-and-inheritance.md`](abstracts-and-inheritance.md) for the
full author-side reference (multi-level chains, cross-file resolution,
overlay semantics, common patterns).

### Escalate to a new subtype only when…

…at least one of these is true:

- **Different runtime node class** (`factory: ...` returns a different
  subclass of `MetaData`). Example: `source.rdb` registers a `MetaSource`
  with `isWritable()` / `tableName` methods that other source kinds wouldn't
  share.
- **Different `childRules`** that can't be expressed as additional attrs.
  Example: `field.enum` requires an `enum.values` attr and a constrained set
  of child types that plain `field.string` doesn't.
- **The closest existing subtype has required attrs that don't apply to
  your concept.** Example: `template.output` requires `@payloadRef` AND
  `@textRef` (both are renderable-template invariants). An LLM tool-call
  envelope needs `@toolName` but has no renderable text body — `@textRef`
  doesn't apply. Extending `template.output` with `@toolName` would force
  every toolcall to declare a stub `@textRef`. A new subtype
  (`template.toolcall` with `@payloadRef` + `@toolName` required, no
  `@textRef`) is the honest fit.
- **The semantic concept is so universal it deserves a name in the closed
  core vocabulary.** Example: `source.rdb` is a persistence-paradigm split —
  there will eventually be `source.kv`, `source.graph`, etc., and they all
  need first-class subtype identity for cross-port codegen routing.
- **You need load-time error detection when the provider is missing.** The
  loader treats undeclared `@-attrs` as **open policy** — they're silently
  accepted, no error or warning (`attr-schema-validate.ts:15`). Only the
  *subtype* itself is validated against the registry. So if your concept's
  correctness depends on the provider being loaded (e.g., a custom generator
  must run when the metadata is present), subtype registration is the only
  mechanism that catches "consumer forgot to wire the provider" at load
  time via `ERR_UNKNOWN_SUBTYPE`. With pure attr-extension, missing
  providers silently no-op.

If the only argument for a new subtype is "the name reads nicer," add an
attr instead. A subtype is a permanent commitment in every port's registry;
an attr is a one-line additive change.

### Decision table

| You want to add… | Mechanism | Why |
|---|---|---|
| A configuration knob on an existing concept (e.g., `@toolName` on outputs) | **`registry.extend` + attr** | No structural change; just configuration |
| A reusable shape that multiple fields share (e.g., slug constraint) | **Abstract + `extends`** | Per-instance inheritance, no metamodel growth |
| A new persistence paradigm or rendering kind | **`registry.register` + subtype** | Genuine structural divergence; new factory/childRules |
| A cross-cutting attribute on all fields (e.g., `@audit-trail`) | **`registry.extend` on each `field.*`** | Same attr, broadcast across an existing closed set |

### Why this hierarchy matters

Every new subtype is a contract that all five ports must understand. A
new attr is just a config knob the existing nodes already accept. An
abstract is pure data the loader resolves at parse time. The marginal cost
goes up sharply at each step: **attr (cheap) < abstract (free) < subtype
(expensive)**. Defaulting to subtypes inflates the metamodel without
adding power; defaulting to attrs keeps the vocabulary narrow and the
configuration rich.

## Cross-port parity status (as of 0.15.19 · 7.7.9)

| Port | API | Status |
|---|---|---|
| TypeScript | `loadMemory(repoRoot, { providers })` + `defineConfig({ providers })` | Shipped |
| C# | `Provider.ComposeRegistry(providers)` → `MetaDataLoader.FromDirectory(dir, registry)` | Shipped |
| Python | `MetaDataLoader.from_directory(dir, providers=...)` | Shipped |
| Java | SPI via `META-INF/services/com.metaobjects.registry.MetaDataTypeProvider` | Shipped (SPI auto-discovery; programmatic `compose()` factory is a follow-up) |
| Kotlin | Inherits Java SPI through `metadata-ktx` | Shipped |

All five ports compose providers in **dependency order** (Kahn's algorithm)
and emit the same stable error codes when composition fails.

## See also

- [`../recipes/extending-metaobjects-with-providers.md`](../recipes/extending-metaobjects-with-providers.md) — hands-on walkthrough
- [`../ports/typescript.md`](../ports/typescript.md), [`../ports/csharp.md`](../ports/csharp.md), [`../ports/python.md`](../ports/python.md), [`../ports/java.md`](../ports/java.md) — per-port quickstarts
- [`templates-and-payloads.md`](templates-and-payloads.md) — the core
  `template.prompt` + `template.output` subtypes that a custom `template.toolcall` slots alongside
- [`source-kinds.md`](source-kinds.md) — the `source.rdb` example of `extend`-style
  provider use (adds `@table`, `@kind`, `@role`, `@schema` to a core subtype)
- [`../../fixtures/conformance/`](../../fixtures/conformance/) — `provider-extension-*` fixtures
- [`../../fixtures/conformance/ERROR-CODES.json`](../../fixtures/conformance/ERROR-CODES.json) — stable error code dictionary

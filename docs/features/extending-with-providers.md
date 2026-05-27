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

export const wizardsToolcallProvider: MetaDataTypeProvider = {
  id: "wizards-template-toolcall",
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
import { wizardsToolcallProvider } from "./codegen/providers";

const root = await loadMemory("./", {
  providers: [wizardsToolcallProvider],   // composed AFTER core providers
});
```

```csharp
// C#
var loader = MetaDataLoader.FromDirectory("./metadata", registry);
// where `registry` is built via Provider.ComposeRegistry(providers)
```

```python
# Python
loader = MetaDataLoader.from_directory("./metadata", providers=[wizards_toolcall_provider])
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
files or **multiple** projects, and the semantics belong in the metamodel:

- ✅ `template.toolcall` (LLM tool-call envelope) — applies to any template
  that drives an LLM with structured-output tooling.
- ✅ `field.slug` (URL-safe opaque short identifier) — applies to any entity
  whose primary key is a generated slug.
- ✅ Cross-cutting attrs like `@audit-trail: true` on `field.*`.

Don't write a provider for one-shot project-specific data — that's what
authored YAML / JSON metadata is for.

## Cross-port parity status (as of 0.7.0-rc.3)

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

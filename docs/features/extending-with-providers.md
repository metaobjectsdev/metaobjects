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
- How to wire a project's own provider into each port (TypeScript, Python, C#, Java,
  Kotlin), with a worked example per language, and which commands load it
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

## The three rules that govern every provider

Before the mechanics, the three rules a provider must obey. All three are machine-enforced —
you will hit an error, not a review comment.

### 1. Own vs projected attributes (ADR-0050)

A provider is a **cluster of capabilities**. It may contribute new types, new subtypes,
attributes intrinsic to its own types, and attributes projected onto types another
provider owns — in any combination, and a projection may target only some subtypes.

| | where it registers | required allowed? |
|---|---|---|
| **OWN** — the type is invalid or not meaningfully itself without it | **with the type**, in the type's own provider | yes |
| **PROJECTED** — your concern applied to a type that is complete without it | in your concern provider, via `extend` | **no — must be optional** |

The invariant: **removing a provider may remove types and optional vocabulary, but must
never invalidate or silently weaken a type another provider registers.** Projecting a
required attribute throws `ERR_EXTEND_REQUIRED_ATTR` at composition, in every port —
because a required attribute registered that way *disappears* when your provider is
composed out, taking its validation rule with it and letting invalid metadata load clean.

The same rule applies, more strongly, to common attributes: those project onto *every*
type, so a required one is refused outright.

### 2. Extension is registration (ADR-0051)

**An undeclared attribute is `ERR_UNKNOWN_ATTR`, on every type, in every port.** There is
no wildcard that quietly accepts unknown attributes — one would also swallow a *typo'd*
core attribute, which is worse than rejecting a valid extension.

So vendor or domain vocabulary enters by **registration**:

- new types or subtypes → `register()` in your own provider;
- optional attributes on shipped types → `extend()` in your own provider;
- arbitrary author-supplied data with no schema → the registered `attr.properties` bag;
- consuming *foreign* models you do not control → loosen `strict`, never for authoring.

"Declared" includes "declared by your provider" — that is what keeps strict provenance
meaningful while still letting you extend the metamodel.

### 3. One attribute name, one provider, per node type (ADR-0062)

**Two providers may not claim the same attribute name on a node type.** The registry records
which provider registered each attribute, and refuses a second provider's claim at composition:

- on the same `(type, subType)` — `ERR_PROVIDER_ATTR_CONFLICT`;
- on the shared root `(type, base)` that the subtype inherits from, or on a subtype of it —
  `ERR_PROVIDER_ATTR_SHADOW`.

The message names both providers and the attribute. The check runs both ways, so it does not
matter which provider registers first. The same provider repeating its own name, sibling
subtypes using one name, and registration outside a provider's turn are all legal.

This is what keeps per-paradigm physical names safe (ADR-0007, ADR-0018). Name your store's
address in your store's own word (`@column` for a relational field, `@field` for a document
field) and pick a word no other provider on that node type already holds. A store you have no
provider for goes in the `attr.properties` bag, not an invented attribute. `meta types
--detail` prints the registering provider next to each attribute, so you can see what is taken.

## What modularity does and does not mean

> **MetaObjects modularity is additive and behavioural, never subtractive: every port
> ships the same vocabulary; a concern your model does not declare costs nothing,
> generates nothing and diagnoses nothing; and downstream providers may add optional
> vocabulary — so any model that loads under the default bundle loads identically in
> every port.**

Concretely, you opt in by **declaring**, not by configuring:

| concern | how you opt in | what exists if you don't |
|---|---|---|
| database | declare a `source.*` child | no table, no queries, no routes |
| UI | list the UI generators in your config | nothing — `meta init` scaffolds none |
| prompts | declare `template.*` nodes | nothing |
| requirements | declare `requirement.*` nodes | nothing — `verify` is silent |

**Vocabulary is not subtractable, and that is deliberate.** You cannot compose a registry
without `template.*` or `index.*`, because a model authored elsewhere would then *fail to
load* rather than degrade — forking the interchange format into dialects, which is the
exact failure a cross-language standard exists to prevent. Registered-but-undeclared
vocabulary costs a model nothing: no generator, runtime or migration path reads a type you
never declare.

Reduced compositions remain available to **library embedders** (`composeRegistry` with a
subset), and ADR-0050 guarantees any reduced composition is *coherent* — no silently
weakened types. Anything a reduced registry loads, the full bundle loads identically.

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

**Extending a spec-declared core subtype survives strict-mode load.**
Adding an attr to a subtype the *library* itself registers (e.g. a
consumer `@decimals` on the core `view.currency`) composes cleanly with a
**strict** load of metadata that uses the new attr — no need to fall back
to `--lax` for the whole file just because one attr came from a consumer
provider. This is conformance-gated across all five ports (the
`compose-load/` fixtures in
[`../../fixtures/provider-composition-conformance/`](../../fixtures/provider-composition-conformance/)).

## Wiring providers into the loader

A provider is code, so it lives in the language of the tools that load the metadata, and it
is wired in that port's own config. Each port then loads it at **every** entry point that
reads metadata, not only codegen. The contract is the same everywhere:

> **The loader composes the core vocabulary plus exactly the providers you name, in
> dependency order.** Nothing is discovered from the classpath, the bundler's import order or
> an installed package. The same provider list and the same metadata give the same registry.

**Every port whose tools load the metadata needs its own copy of the provider.** A provider
registered only in TypeScript is invisible to the Java build, the Python CLI or the C# tool,
and they refuse the same file with `ERR_UNKNOWN_SUBTYPE` / `ERR_UNKNOWN_ATTR`. Give each copy
the same `id` and the same vocabulary; the shared conformance fixtures
`provider-custom-vocabulary-success` and `provider-custom-vocabulary-missing-provider-fails`
hold every port to that.

The examples below all add the same vocabulary: a new `layout.picker` subtype with its own
`@displayField` attribute, and two optional attributes on the core `field.string`,
`@searchable` (boolean) and `@valueLabels` (string array). The metadata then uses it like
core vocabulary:

<!-- meta-example: external-provider -->
```json
{ "metadata.root": { "package": "acme", "children": [
  { "object.value": { "name": "Contact", "children": [
    { "field.string": { "name": "name", "@searchable": true } },
    { "field.string": { "name": "status", "@valueLabels": ["Active", "On hold"] } },
    { "layout.picker": { "name": "contactPicker", "@displayField": "name" } }
  ]}}
]}}
```

The agent-context skill carries the same example per language
(`agent-context/skills/metaobjects-authoring/references/<language>-providers.md`).

### TypeScript

```ts
// codegen/vocabulary.ts
import { TypeId, MetaLayout, type MetaDataTypeProvider } from "@metaobjectsdev/metadata";
import {
  TYPE_FIELD, TYPE_LAYOUT, FIELD_SUBTYPE_STRING,
  ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_BOOLEAN,
} from "@metaobjectsdev/metadata/constants";

export const vocabulary: MetaDataTypeProvider = {
  id: "acme-vocabulary",
  dependencies: ["metaobjects-core-types"],
  registerTypes(registry) {
    registry.register({
      typeId: new TypeId(TYPE_LAYOUT, "picker"),
      description: "A picker over the owning object.",
      factory: (typeId, name) => new MetaLayout(typeId, name),
      childRules: [],
      attributes: [
        { name: "displayField", valueType: ATTR_SUBTYPE_STRING, required: false, description: "Field shown per choice." },
      ],
    });
    registry.extend(TYPE_FIELD, FIELD_SUBTYPE_STRING, {
      attributes: [
        { name: "searchable", valueType: ATTR_SUBTYPE_BOOLEAN, required: false, description: "Offer in search." },
        { name: "valueLabels", valueType: ATTR_SUBTYPE_STRING, isArray: true, required: false, description: "Display labels." },
      ],
    });
  },
};
```

Wire it in `metaobjects.config.ts`:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { vocabulary } from "./codegen/vocabulary";

export default defineConfig({ generators: [/* ... */], providers: [vocabulary] });
```

**Loaded by:** `meta gen` (including the docs generators and the docs site), `meta verify`
(every mode), `meta migrate`, `meta fmt`, `meta types`, `meta export`, `meta deps`,
`meta upgrade` and `meta prompt-snapshot`. A config that fails to load is reported as its own
error, never misreported as an unknown subtype. Programmatic loads pass the list:
`loadMemory(root, { providers: [vocabulary] })` composes the default core set plus yours;
`replaceDefaults: true` composes yours alone (rare).

### Python

```python
# acme_vocab.py (beside metaobjects.config.yaml)
from metaobjects.meta.presentation.layout.meta_layout import MetaLayout
from metaobjects.provider import Provider
from metaobjects.registry import AttrSchema, ChildRule, TypeDefinition
from metaobjects.shared.base_types import TYPE_ATTR

provider = Provider("acme-vocabulary", dependencies=("metaobjects-core-types",))
provider.add(TypeDefinition(
    type="layout", sub_type="picker", factory=MetaLayout,
    attrs=[AttrSchema("displayField", "string", required=False)],
    child_rules=[ChildRule(TYPE_ATTR, "*")],
))
provider.on_register(lambda registry: registry.extend(
    "field", "string",
    attributes=[
        AttrSchema("searchable", "boolean", required=False),
        AttrSchema("valueLabels", "string", required=False, is_array=True),
    ],
))
```

Wire it in `metaobjects.config.yaml` as `module:symbol`; the module resolves relative to the
config's directory:

```yaml
metadata: metaobjects
providers: ["acme_vocab:provider"]
```

**Loaded by:** `metaobjects gen` (including the docs generators), every `metaobjects verify`
mode and `metaobjects fmt`. `--provider module:symbol` adds to the configured list for one
run. Programmatic loads pass the full set, core first, because `providers=` is exactly what
is composed:
`MetaDataLoader.from_directory("metaobjects", providers=[*core_providers, provider], strict=True)`
(`core_providers` from `metaobjects.core_types`).

### C#

```csharp
// vocabulary/AcmeVocabularyProvider.cs, in a class library referencing the MetaObjects
// package at the version your `dotnet meta` tool runs.
using MetaObjects;
using MetaObjects.Meta;
using MetaObjects.Shared;

namespace Acme.Vocabulary;

public sealed class AcmeVocabularyProvider : IMetaDataTypeProvider
{
    public string Id => "acme-vocabulary";
    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        registry.Register(new TypeDefinition(
            typeId: new TypeId("layout", "picker"),
            description: "A picker over the owning object.",
            childRules: [new ChildRule(BaseTypes.TYPE_ATTR, Structural.CHILD_RULE_WILDCARD, Structural.CHILD_RULE_WILDCARD)],
            factory: (typeId, name) => new MetaLayout(typeId, name),
            attributes: [new AttrSchema("displayField", "string", Required: false)]));

        registry.Extend("field", "string", attributes:
        [
            new AttrSchema("searchable", "boolean", Required: false),
            new AttrSchema("valueLabels", "string", Required: false, IsArray: true),
        ]);
    }
}
```

Wire it in `.metaobjects/config.json`. `assembly` is the built dll, relative to the directory
holding `.metaobjects/`; `type` is the provider's full type name, and the class needs a public
parameterless constructor:

```json
{
  "schema_version": 1,
  "csharp": {
    "providers": [
      { "assembly": "vocabulary/bin/Debug/net8.0/Acme.Vocabulary.dll", "type": "Acme.Vocabulary.AcmeVocabularyProvider" }
    ]
  }
}
```

**Loaded by:** `dotnet meta gen` and `verify --codegen` (through the project's `codegen/`
runner), `dotnet meta verify` (templates, requirements, field lint) and `dotnet meta fmt`.
Build the vocabulary first; a missing dll, a missing type or a type that is not a provider is
refused with an error naming `csharp.providers`. If the `codegen/` project also references
the vocabulary project, the already-loaded assembly is reused. Programmatic loads compose the
registry themselves, and `ComposeRegistry` takes exactly the set given:
`Provider.ComposeRegistry([.. CoreTypes.LibraryProviders, new AcmeVocabularyProvider()])`,
then `MetaDataLoader.FromDirectory(dir, registry, strict: true)`.

### Java

```java
package com.acme.vocab;

import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.StringField;
import com.metaobjects.layout.MetaLayout;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

public final class AcmeVocabulary implements MetaDataTypeProvider {
    /** The node class behind layout.picker. */
    public static final class PickerLayout extends MetaLayout {
        public PickerLayout(String name) { super("picker", name); }
    }

    @Override public String getProviderId() { return "acme-vocabulary"; }
    @Override public String[] getDependencies() { return new String[] {"field-types", "layout-types"}; }

    @Override public void registerTypes(MetaDataRegistry registry) {
        registry.registerType(PickerLayout.class, def -> {
            def.type("layout").subType("picker").inheritsFrom("layout", "base");
            def.optionalAttributeWithConstraints("displayField").ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
        registry.extendType(StringField.class, def -> {
            def.optionalAttributeWithConstraints("searchable").ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
            def.optionalAttributeWithConstraints("valueLabels").ofType(StringAttribute.SUBTYPE_STRING).asArray();
        });
    }
}
```

The JVM provider ids differ from the other ports': depend on `field-types` and
`layout-types` (the providers that register those types), not `metaobjects-core-types`.

Wire it in the `metaobjects-maven-plugin` configuration. The class must be on the plugin's
classpath, so put it in its own module and add that module as a project dependency or under
the plugin's `<dependencies>`; a provider in the same module is not compiled yet when
`generate` runs at `generate-sources`.

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <configuration>
    <providers>
      <provider>com.acme.vocab.AcmeVocabulary</provider>
    </providers>
  </configuration>
  <dependencies>
    <dependency><groupId>com.acme</groupId><artifactId>acme-vocabulary</artifactId><version>1.0</version></dependency>
  </dependencies>
</plugin>
```

**Loaded by:** `metaobjects:generate` (including the docs generators), `metaobjects:verify`,
`metaobjects:fmt` and `metaobjects:editor` (`-Dmeta.providers=...` on the command line works
too). A Spring Boot app declares the provider as a bean, and the auto-configured loader
composes every `MetaDataTypeProvider` bean:
`@Bean MetaDataTypeProvider acmeVocabulary() { return new AcmeVocabulary(); }`.
Programmatic loads pass it on the options:
`LoaderOptions.create(false, false, true).setProviders(List.of(new AcmeVocabulary()))`.
The loader composes the full metamodel set plus these
(`RegistryManifest.composeLoaderRegistry(extras)`).

**Listing a class in `META-INF/services` does not add it to the loader.** The strict loader
composes a fixed metamodel set plus the providers you name, so a jar on the classpath cannot
change the vocabulary by accident.

### Kotlin

Kotlin runs on the JVM registry, so the provider is the same interface written in Kotlin, and
it is wired the same way: the Maven plugin's `<providers>` list (Kotlin generators run
through `metaobjects:generate`), a Spring bean, or `providers = listOf(...)` on the
`metadata-ktx` loader:

```kotlin
class PickerLayout(name: String) : MetaLayout("picker", name)

class AcmeVocabulary : MetaDataTypeProvider {
    override fun getProviderId() = "acme-vocabulary"
    override fun getDependencies() = arrayOf("field-types", "layout-types")

    override fun registerTypes(registry: MetaDataRegistry) {
        registry.registerType(PickerLayout::class.java) { def ->
            def.type("layout").subType("picker").inheritsFrom("layout", "base")
            def.optionalAttributeWithConstraints("displayField").ofType("string").asSingle()
        }
        registry.extendType(StringField::class.java) { def ->
            def.optionalAttributeWithConstraints("searchable").ofType("boolean").asSingle()
            def.optionalAttributeWithConstraints("valueLabels").ofType("string").asArray()
        }
    }
}

val result = loadUris("app", uris, LoaderOptions.create(false, false, true), providers = listOf(AcmeVocabulary()))
```

### Without the provider

The same file, loaded strictly without the provider, fails with `ERR_UNKNOWN_SUBTYPE` on
`layout.picker` and `ERR_UNKNOWN_ATTR` on each of `@searchable` and `@valueLabels`, in that
order, in every port. A lax load accepts the unknown attributes but still refuses the unknown
subtype.

### The TypeScript forge provider

**`forgeTypesProvider` is TypeScript-only, and is no longer in any default
composition.** It was listed here as part of the default composition for "the TS / C# /
Python loaders"; in fact only TypeScript ever had it, and no C#, Python, Java or Kotlin
registry registers any `@forge*` attribute or `decision` / `principle` / `convention` /
`glossary` / `failure` type at all. Nor does `expected-registry.json`, the manifest all
five ports byte-match, so the cross-port gate never had jurisdiction over it — one
document had two verdicts, decided by which toolchain read it, and 1.0 would have frozen
that in.

At the 1.0 cut it left `defaultLoadMemoryProviders` and `meta types`. It is still
exported and unchanged, as the chartered opt-in:

```ts
const root = await loadMemory("./", { providers: [forgeTypesProvider] });
```

A project taking it knows it has a surface the other four ports do not.

## Stable error codes

Composition surfaces these codes consistently across all ports (see
[`../../fixtures/conformance/ERROR-CODES.json`](../../fixtures/conformance/ERROR-CODES.json)):

| Code | When | Conformance fixture |
|---|---|---|
| `ERR_UNKNOWN_TYPE` | YAML/JSON references a `type` not registered by any provider — including a BARE wrapper key naming an unregistered type, which is an unknown type and not a missing subType | `error-unknown-bare-child-type` |
| `ERR_UNKNOWN_SUBTYPE` | `type` is known but `subType` is not | `provider-extension-missing-provider-fails`, `provider-custom-vocabulary-missing-provider-fails` |
| `ERR_UNKNOWN_ATTR` | A strict load meets an attribute no provider declared on that `(type, subType)` | `provider-custom-vocabulary-missing-provider-fails` |
| `ERR_CHILD_NOT_OBJECT` | A `children` entry's body is not an object, so there is no node to read — checked AFTER the wrapper key resolves | `error-child-not-object` |
| `ERR_PROVIDER_DUPLICATE_ID` | Two provider objects report the same `id` | `provider-extension-duplicate-id` |
| `ERR_PROVIDER_MISSING_DEPENDENCY` | Provider declares dep on an unregistered id | `provider-extension-missing-dependency` |
| `ERR_PROVIDER_DEPENDENCY_CYCLE` | Provider dependencies form a cycle | `provider-extension-dependency-cycle` |
| `ERR_PROVIDER_ATTR_CONFLICT` | Two providers declare the same attr on the same `(type, subType)` | `attr-conflict` (provider-composition corpus) |
| `ERR_PROVIDER_ATTR_SHADOW` | A provider declares an attr another provider already holds on the shared root or a descendant subtype of the same type | `attr-shadow-inherited`, `attr-shadow-descendant` (provider-composition corpus) |

Each conformance fixture's `providers.json: string[]` lists the provider ids to
compose for that test — the same wire format consumers use at runtime. Each
port's conformance adapter maps those ids to its own provider objects, and the
fixtures run in every port (TypeScript, C#, Java, Kotlin, Python), so any future
port inherits the contract. `provider-custom-vocabulary-success` loads a
project-defined subtype plus attributes on a core type with the provider;
`provider-custom-vocabulary-missing-provider-fails` refuses the same file
without it.

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
- **You need load-time error detection even in a lax load.** A strict load
  (the default for every tool) refuses an undeclared `@-attr` with
  `ERR_UNKNOWN_ATTR`, so a missing provider is caught either way. A lax load
  (`--lax`, `strict: false`) accepts undeclared attrs and refuses only an
  unknown *subtype*. So if your concept's correctness depends on the provider
  being loaded even where a project loads laxly, subtype registration is the
  mechanism that still catches "consumer forgot to wire the provider", via
  `ERR_UNKNOWN_SUBTYPE`.

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

## Cross-port parity status

| Port | Project config | Programmatic | Status |
|---|---|---|---|
| TypeScript | `defineConfig({ providers })` in `metaobjects.config.ts` | `loadMemory(root, { providers })` | Shipped |
| Python | `providers: ["module:symbol"]` in `metaobjects.config.yaml`, plus `--provider` | `MetaDataLoader.from_directory(dir, providers=[*core_providers, ...])` | Shipped |
| C# | `csharp.providers: [{ assembly, type }]` in `.metaobjects/config.json` | `Provider.ComposeRegistry(...)` → `MetaDataLoader.FromDirectory(dir, registry)` | Shipped |
| Java | Maven plugin `<providers>`; Spring `MetaDataTypeProvider` beans | `LoaderOptions.setProviders(...)` | Shipped |
| Kotlin | Maven plugin `<providers>`; Spring beans | `metadata-ktx` `loadUris(..., providers = listOf(...))` | Shipped |

All five ports compose providers in **dependency order** (Kahn's algorithm)
and emit the same stable error codes when composition fails.

## Defining a custom top-level node type

`metadata.root`'s child rules are a **closed set** — by design (FR-033 fail-closed
hardening): a document root admits `object` / `field` / `validator` / `template` nodes
and nothing else. So registering a new top-level subtype via a provider is **two steps**,
both in the same provider's `registerTypes`:

1. `registry.register(...)` the new `(type, subType)` — this declares the vocabulary
   *exists*, not where it may *live*.
2. `registry.extend(TYPE_METADATA, SUBTYPE_ROOT, { childRules: [...] })` to **license**
   it as a permitted child of `metadata.root`.

Skip step 2 and the node fails to load with `ERR_CHILD_NOT_ALLOWED`. This is
deliberate, not a papercut: registration declaring existence and the parent declaring
admission are separate concerns (most registered subtypes — `view.image`,
`template.toolcall` — are emphatically *not* root-level), and root admission is part of
the byte-matched cross-port registry manifest. Auto-admitting every new type at the
document root would be fail-open and would take admission out of the declarative record.

```ts
registerTypes(registry) {
  registry.register({ typeId: new TypeId("adapter", "http"), /* … */ });
  registry.extend(TYPE_METADATA, SUBTYPE_ROOT, {
    childRules: [{ childType: "adapter", childSubType: "*", childName: "*" }],
  });
}
```

A **reference to your custom top-level type resolves package-aware for free** — a
`ReferenceDescriptor` with `targetType: "adapter"` on some other node validates through
the same resolver as `@objectRef` (FQN-exact, else the referrer's package, else
root-level), so you do **not** hand-walk the tree in a `validate` hook.

## See also

- [`../recipes/extending-metaobjects-with-providers.md`](../recipes/extending-metaobjects-with-providers.md) — hands-on walkthrough
- [`../ports/typescript.md`](../ports/typescript.md), [`../ports/csharp.md`](../ports/csharp.md), [`../ports/python.md`](../ports/python.md), [`../ports/java.md`](../ports/java.md), [`../ports/kotlin.md`](../ports/kotlin.md) — per-port quickstarts
- [`templates-and-payloads.md`](templates-and-payloads.md) — the core
  `template.prompt` + `template.output` subtypes that a custom `template.toolcall` slots alongside
- [`source-kinds.md`](source-kinds.md) — the `source.rdb` example of `extend`-style
  provider use (adds `@table`, `@kind`, `@role`, `@schema` to a core subtype)
- [`../../fixtures/conformance/`](../../fixtures/conformance/) — `provider-extension-*` and `provider-custom-vocabulary-*` fixtures
- [`../../fixtures/conformance/ERROR-CODES.json`](../../fixtures/conformance/ERROR-CODES.json) — stable error code dictionary

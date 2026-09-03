# Migration — a `<type>.base` node no longer loads

**Breaking on the metadata axis.** `metamodelVersion` moves `0.13` → `0.14`. If your metadata
never writes a wrapper key ending in `.base`, there is nothing to do — and most projects never
have, because naming an abstract anchor was only ever possible by accident.

Check with one search across your metadata:

```
grep -rn '"\(attr\|field\|layout\|object\|origin\|relationship\|source\|template\|validator\|view\)\.base"' metaobjects/
```

(YAML authors: the same keys, sigil-free — `field.base:` and friends.)

## What changed

Every type family registers a `base` subtype — `attr.base`, `field.base`, `layout.base`,
`object.base`, `origin.base`, `relationship.base`, `source.base`, `template.base`,
`validator.base`, `view.base`. Each is the shared root its concrete subtypes inherit attrs and
child rules from. It has no runtime semantics and no concrete representation, which is why every
one of their descriptions in the registry manifest opens with **Abstract** and why
`spec/metamodel/object.json` had already said, in as many words, *"not authored directly"*.

Authoring one now fails the load with **`ERR_ABSTRACT_SUBTYPE_AUTHORED`**, in all five ports.

## Why, if it worked before

**It did not work before — it worked on three ports of five.** Java and Kotlin already refused
every one of these, because their implementation classes are `abstract` and instantiating one
throws. TypeScript, C# and Python accepted them. So a document using `object.base` loaded in a
Node or .NET or Python toolchain and failed to load in a Maven build, with a message about a
missing constructor that named neither the rule nor the reason.

That is the cross-language conformance gap the shared corpora exist to catch. It survived because
all ten `base` subtypes sat in the corpus's own list of vocabulary no fixture exercises — nothing
tested them in either direction.

Full reasoning: [ADR-0054](../../../spec/decisions/ADR-0054-base-subtypes-are-not-authorable.md).

## What to write instead

Name the concrete subtype you meant. In every case the base node was standing in for one:

| Was | Write |
|---|---|
| `field.base` with an `extends` to an abstract field | the super's own subtype — `field.long`, `field.string`, … |
| `object.base` | `object.entity`, `object.value` or `object.projection` |
| `source.base` | `source.rdb` |
| `validator.base` | `validator.required`, `validator.length`, `validator.regex`, … |
| `view.base` | a concrete view subtype — see the note below |
| `attr.base` as an authored child | the inline `@name: value` form (below) |

### An untyped `@default` needs no `attr.base`

`attr.base` is real, and it is what an untyped `@default` resolves to — its value type follows
the owning field's subtype, so a boolean default stays a boolean rather than being stringified.
**The loader picks that subtype; an author never names it.** Write the inline form:

```jsonc
// before — an authored attr child
{ "field.boolean": { "name": "enabled", "children": [
    { "attr.base": { "name": "default", "value": false } } ] } }

// after — the inline form, same polymorphic subtype, same type preservation
{ "field.boolean": { "name": "enabled", "@default": false } }
```

### `view.base` is the one genuine removal

`view.base` was a view carrying no kind. Core registers only `view.base` and `view.currency`; the
other view subtypes (`view.text`, `view.textarea`, `view.checkbox`, `view.radio`, `view.image`, …)
come from the TypeScript-side UI provider. A project on a port that does not apply that provider
therefore has `view.currency` and nothing else until it does.

Nothing is lost that carried information — a `view.base` node declared no kind and no attrs, and
the JVM never accepted one — but if you were using it as a placeholder, delete it rather than
substituting a kind you do not mean.

### A read-only primary beside a writable one is now inexpressible

If you reached for `object.base` to declare an object with a read-only primary source **and** a
writable one, that shape is refused by `object.entity` (`ERR_ENTITY_PRIMARY_SOURCE_READONLY`) and
by `object.projection` (`ERR_PROJECTION_SOURCE_WRITABLE`). It only loaded because `object.base`
carries neither rule. What you probably want is a **write-through entity**: an `object.entity`
with a writable `@role: primary` table and a read-only `@role: replica` view. See
[FR-024 §7 / `docs/features/api-contract.md`](../api-contract.md).

## Bare type keys in JSON now behave the way YAML always has

A bare `{"object": …}` key — no `.subType` fused in — resolves to the type's **declared default**.
That was always the contract: the YAML desugar has used it forever, and the shared corpus pins it
(bare `object:` becomes `object.entity`). The four JSON parsers were not asking the registry —
TypeScript and C# guessed at registration order, the JVM hardcoded the anchor, and Python refused
bare keys outright — so the same key meant up to four different things.

**If you write bare keys in JSON, one changes and the rest were already broken:**

| Bare key | Before | Now |
|---|---|---|
| `{"object": …}` | anchor (TS/C#), instantiation failure (JVM), refused (Python) | `object.entity`, everywhere |
| `{"field": …}`, `{"source": …}`, `{"view": …}`, … | same mess | `ERR_MISSING_SUBTYPE` — those types declare no default |

For the second row, write the subtype:

```jsonc
{ "field": { "name": "label" } }          // refused — `field` declares no default
{ "field.string": { "name": "label" } }   // write this
```

If a type later declares a concrete default, its bare key starts resolving again — purely additive,
nothing to redo.

# ADR-0054: A `<type>.base` subtype is a registry anchor, not an authorable node

## Status

**Accepted** (2026-09-02). Breaking on the metadata axis: `metamodelVersion` `0.13` → `0.14`
(pre-1.0, so a metamodel MINOR). No package-version consequence — ADR-0035 Amendment 2 keeps the
two contracts on two numbers.

## Context

Every type family registers a `base` subtype: `attr.base`, `field.base`, `layout.base`,
`object.base`, `origin.base`, `relationship.base`, `source.base`, `template.base`,
`validator.base`, `view.base`. Each is the shared root its concrete subtypes inherit attrs and
child rules from, and each is described in the byte-gated registry manifest with a description
opening on the word **Abstract**. Two of them — `object.base` and `relationship.base` — said the
rest out loud: *"Has no runtime semantics of its own; not authored directly."*

**Three ports did not enforce that, and two did.** Measured across all six `base` subtypes a
document can name:

| Port | `{"object.base": …}` and its siblings |
|---|---|
| TypeScript | LOADS |
| Python | LOADS |
| C# | LOADS |
| Java | fails to load |
| Kotlin | fails to load (inherits the JVM loader) |

The JVM refusal was **accidental**, not designed: `MetaObject`, `MetaField`, `MetaSource`,
`MetaAttribute` and friends are `public abstract`, so instantiating one throws. The message named a
missing constructor, not a rule — nothing in it said the shape was forbidden or why.

So the same document loaded on three ports and failed to load on two. That is precisely the
cross-language conformance gap the shared corpora exist to catch, and it survived because
**every one of the ten `base` subtypes sat in the registry corpus's own `untestedSubTypes`
list**. Nothing exercised them, in either direction, anywhere.

The gap had already done damage inside this repository. Three test fixtures reached for
`object.base` *because* it was the only subtype loose enough to express a shape the concrete
subtypes reject — an object carrying a read-only primary source beside a writable one. Each carried
a comment explaining that `object.base` "carries none of the subtype-specific structural rules",
which is true, and treated that as a licence rather than as evidence the shape did not belong in a
document. One of those comments then hardened into a claim in the Kotlin port that a whole class of
defect "could not be constructed on this port" — reasoning from `object.base`'s absence on the JVM
to a general conclusion that was wrong on two other shapes.

## Decision

**An explicitly authored `<type>.base` node fails to load, in every port, with
`ERR_ABSTRACT_SUBTYPE_AUTHORED`.**

Three clauses make that precise:

1. **Scoped to the EXPLICIT spelling.** `base` is also each parser's internal fallback: for a bare
   `{"field": …}` key whose registry default is unregistered, and — in the loader, never by an
   author — as the polymorphic subtype an untyped `@default` resolves to, so its value type follows
   the owning field. Those paths are untouched. The rule refuses what an author WROTE, not what a
   loader CHOSE.

2. **Both doors, in every port.** The root wrapper key and the child wrapper key are separate entry
   points in all five parsers. A check on one of two doors is a rule that is only half true.

3. **Written into the byte-gated contract.** All ten `base` descriptions now carry the sentence and
   the error code, so no port has to infer the rule from another port's source. This is the
   `0.24.1` precedent: a cross-port rule lives in the manifest, not in whichever implementation
   happened to enforce it.

`fixtures/conformance/error-abstract-subtype-authored` gates it in all five ports, and the coverage
report no longer lists the ten anchors as untested backlog — they are excluded from the coverage
universe, because a subtype no document may name is a contract, not a chore.

## Consequences

**Adopter-visible, and this is a migration.** Metadata authoring any `<type>.base` node stops
loading. `docs/features/migrations/base-subtypes-are-not-authorable.md` carries the mapping; in
every case it is naming the concrete subtype that was meant.

**One capability is genuinely removed rather than renamed.** `view.base` was the only way to author
a view carrying no kind in the ports that do not apply the TS-side UI provider, which registers
`view.text`, `view.textarea` and the rest. Those ports now have `view.currency` and nothing else
until they compose that provider. A `view.base` node conveyed no kind and no attrs, and the JVM
never accepted one, so what is lost is the ability to write a node that said nothing — but the loss
is real and is stated rather than glossed.

**A shape used by three in-repo fixtures becomes inexpressible**, and that is the point rather than
a cost: a read-only primary source beside a writable one on a single object is refused by
`object.entity` (`ERR_ENTITY_PRIMARY_SOURCE_READONLY`) and by `object.projection`
(`ERR_PROJECTION_SOURCE_WRITABLE`). It only ever loaded because `object.base` carried neither rule.
The fixtures that needed a two-primary divergence moved to shapes the concrete subtypes admit: an
`object.entity` extending an abstract `object.projection`, and two plain entities each declaring
their own table.

**What this ADR does NOT decide, stated because measuring it is what produced this one.** A BARE
type key (`{"field": …}`, `{"object": …}`) resolves to `<type>.base` in TypeScript and loads there,
while the JVM resolves the same key the same way and then fails to instantiate it — so bare keys
diverge across the ports exactly as the explicit spelling did. `CLAUDE.md` documents a third
behaviour again ("a bare `object:` key resolves to entity") that no port implements. That is a
distinct question about what a default subtype should BE, with its own blast radius, and folding it
into this decision would have settled it by accident. It is recorded here so the next reader does
not have to rediscover it.

## Alternatives considered

**Make the JVM accept `*.base` instead** — register concrete impl classes so all five agree the
permissive way. Non-breaking, no version move, no reset of the 1.0 quiet period. Rejected because it
inverts the contract: the manifest calls these subtypes abstract, and the prose would have had to
change to match the implementation rather than the implementation changing to match the prose. A
node that declares an anchor rather than a thing has no meaning for codegen or runtime to act on.

**Report the divergence and change nothing.** Rejected: the report was the cheap half, and leaving
one document with two verdicts is the failure the corpora exist to prevent.

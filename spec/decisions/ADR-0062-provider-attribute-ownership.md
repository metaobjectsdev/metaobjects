# ADR-0062: Two providers may not claim one attribute name on a node type

## Status

**Accepted** (2026-11-04). Registers no vocabulary: `metamodelVersion` is unchanged. Adds one
error code, `ERR_PROVIDER_ATTR_SHADOW`, and records which provider registered each attribute.
Amends nothing; it states how ADR-0007 and ADR-0018 are meant to scale. Closes #527.

## Context

ADR-0007 gave each storage paradigm its own physical-name word on the node it describes
(`@column` for a relational field, `@field` for a document field) and rejected a shared
`@locator`-style attribute, because one word cannot hold a multi-sourced field's address in two
stores at once. ADR-0018 did the same per kind (`@table`, `@view`). That scheme works only while
no two providers choose the same word. A provider is free to register or extend a type, and
the registry used to stop only the narrowest case: a second `extend` of the same
`(type, subType)` redeclaring an attribute (`ERR_PROVIDER_ATTR_CONFLICT`). It did not stop a provider
that put `@column` on `field.base` while another already had `@column` on `field.string`, or
the reverse. Both registered, the loader saw one name with two meanings, and which won depended
on registration order. Issue #527 asked where a per-provider physical name goes and what stops
a collision.

## Decision

1. **A per-paradigm idiomatic word, unique across providers on a node type.** Each provider
   names its physical address in the word its own store uses. Two providers do not share a word
   on a node type. The registry enforces it at registration, not in review.

2. **The rule.** A provider that registers or extends `(T, S)` with attribute `A` is refused when
   a different provider already registered `A` on a *related slot* of the same node type `T`:
   - the same slot `(T, S)` — `ERR_PROVIDER_ATTR_CONFLICT` (unchanged code; its message now also
     names the owning provider);
   - an inherited slot, the shared root `(T, base)` — `ERR_PROVIDER_ATTR_SHADOW`;
   - when `S` is the shared root, any registered subtype `(T, S')` — `ERR_PROVIDER_ATTR_SHADOW`.

   The check runs in both directions, so the verdict does not depend on which provider registers
   first, and whether the second provider registers the slot or `extend`s it. A name a subtype
   only inherits from the shared root is the root's, so declaring it on the subtype is a shadow,
   not a same-slot repeat. A refusal names both providers and the attribute, and leaves nothing
   behind in the registry.

   A common attribute is accepted on every node type, so it is on every slot at once. A provider
   that registers common attribute `A` is refused with `ERR_PROVIDER_ATTR_CONFLICT` when a
   different provider already registered `A` as a common attribute or on any `(T, S)`; and a
   provider that registers or extends any `(T, S)` with `A` is refused with the same code when a
   different provider already registered common attribute `A`. Both orders reach the same verdict.

3. **What stays legal.** The same provider declaring a name on several related slots (its own
   `@x` on the root and on a subtype) and re-registering its own slot. Sibling subtypes using
   one name, because they are different slots and never co-resolve. Registration outside any
   provider's turn (a direct `registry.register` call in a test or script) claims nothing.

4. **Scope is one node type.** The JVM registry also chains every `<type>.base` to
   `metadata.base`, which the core-types provider owns. No other port has that edge, and several
   shipped providers re-declare `@isAbstract` on their own root with the same meaning. The rule stops at the node-type boundary so all five ports reach the same
   verdict, and no shipped provider has to change.

5. **Owner tracking.** The registry records the registering provider per `(type, subType,
   attribute)`, and per common attribute. The error uses it, and `meta types` shows it
   (`[<provider>]` beside each attribute with `--detail`, and a `provider` field in JSON). The
   owner is not written into the expected-registry manifest, which is byte-matched across ports.

6. **A store with no provider uses a property bag.** Vocabulary an adopter has no provider for
   goes in the registered `attr.properties` bag (ADR-0023), not in an invented attribute.

7. **No wire-name attribute is added here.** If one is added later, it follows this rule with
   its own idiomatic word, and does not take a name another provider already holds.

## Consequences

- The shipped core providers compose with no collision in any port (audited before the check was
  turned on), so existing adopters see no change.
- A third-party provider that reuses a core or sibling provider's attribute name now fails at
  composition with a message that names both providers. The fix is a different idiomatic word.
- The Java port's core providers (`core-types`, `object-types`, `identity-types`,
  `relationship-types` and `index-types`) used to declare a per-type `@description` beside the
  documentation provider's common `@description`, each an optional single string with the same
  meaning. They no longer do: the documentation provider is that name's one owner, as it already
  is in the other ports, and `@description` is still accepted on every node through the common
  attribute. The registry manifest's `description` carve-out for the per-type copies is gone with
  them.
- The two codes split by where the clash is, not by severity: `ERR_PROVIDER_ATTR_CONFLICT` keeps
  its established same-slot meaning and fixture, and `ERR_PROVIDER_ATTR_SHADOW` is the new
  inherited/descendant case.
- Conformance: `fixtures/provider-composition-conformance/` carries the refusals
  (`attr-shadow-inherited`, `attr-shadow-descendant`, `attr-shadow-extend`,
  `common-attr-conflict`, `common-attr-per-type-after`, `common-attr-per-type-before`) and an `attr-ownership/` sub-corpus where composition succeeds and each
  port reports the same owner per attribute and per common attribute.

## Alternatives considered

- **A generic physical-address attribute** — rejected in ADR-0007 for the same reasons.
- **Prefix every provider attribute with the provider id** — rejected in ADR-0018: it makes the
  authoring surface ugly to fix a problem a registry check solves.
- **Last registration wins** — what happened before; the result depends on provider order.
- **One new code for all three cases** — would have changed the established
  `ERR_PROVIDER_ATTR_CONFLICT` fixture and message for existing consumers.

# ADR-0006 — Metadata document structure: reserved structural keywords vs `@`-prefixed inline attributes

**Status:** Proposed (2026-05-23)

## Context

Every metadata node serializes as a single fused-key object — `{"object.entity": { ...body... }}` — whose **body** mixes two kinds of keys:

- **Reserved structural keywords** — a small, *closed* vocabulary that describes the node's
  shape and identity: `name`, `package`, `extends`, `abstract`, `overlay`, `isArray`,
  `children`, `value`. Written **bare** (no sigil).
- **Inline attributes** — an *open*, extensible namespace of typed `@`-prefixed key/values
  (`@payloadRef`, `@dbColumn`, `@maxLength`, …) that decorate a node.

`spec/wire-format.md` already states this ("the reserved structural keys are exactly those
listed … everything else is either an `@`-prefixed attribute or invalid", and "`isArray` …
structural, NOT an `@`-attr"). The two namespaces are meant to be **disjoint**: the `@` sigil
is *exclusively* the inline-attribute namespace; reserved words are *exclusively* bare.

**The problem this ADR fixes:** the language ports never *enforced* disjointness. A reserved
word written with a sigil — `@isArray` — was silently accepted as an inline attribute named
`isArray`. That produced **two incoherent ways to express the same concept**: the structural
`isArray` property (which marks a field as a collection) versus a meaningless attribute that
does *not*. One shared conformance fixture (`origin-collection-simple`) was authored with
`@isArray`, and the TS Python entity-codegen briefly papered over the split by reading array-ness
from *either* form — masking the incoherence rather than resolving it. They cannot both be valid.

**Prior art** (validates the design, not just the bug fix):
- The closed-keyword-vs-open-extension split with a distinguishing sigil is the **OpenAPI**
  model — bare names are spec keywords; `x-`-prefixed names are vendor extensions, which
  "must not conflict with existing keywords." MetaObjects mirrors this with the sigil on the
  attribute side (`@`) and the structural vocabulary bare. JSON Schema is similar (`$`-core
  keywords + ignored/custom keywords).
- `isArray` as a **boolean modifier on a typed field** (rather than array-as-its-own-type) is
  the **Protocol Buffers `repeated`** lineage, shared by GraphQL (`[T]`) and TypeScript
  (`T[]`). JSON Schema/OpenAPI/Avro instead model array as a distinct type (`type: array` +
  `items`). MetaObjects deliberately follows the modifier family: a field has an element
  subtype (`field.string`, `field.object` + `@objectRef`) plus a structural `isArray` flag.

## Decision

1. **Two disjoint namespaces.** A node body contains exactly: reserved structural keywords
   (bare) and inline attributes (`@`-prefixed). Nothing else is valid.

2. **The reserved structural keyword set is closed and fixed:** `name`, `package`, `extends`,
   `abstract`, `overlay`, `isArray`, `children`, `value`. (Canonical key order is defined in
   `spec/wire-format.md`.) Growing this set is itself an ADR-level change.

3. **Array-ness is structural.** A field is a collection iff its bare `isArray` reserved
   keyword is `true`. This is the sole representation; array-ness is never an attribute.

4. **`@<reserved-word>` is a hard load error.** Applying the `@` sigil to any reserved
   keyword name (e.g. `@isArray`, `@abstract`, `@name`) is a category error — using the
   attribute namespace for a structural word — and fails the load with **`ERR_RESERVED_ATTR`**.
   This is enforced identically in **every** language port; an error conformance fixture pins it.

5. **Consumers read the canonical form only.** Codegen, runtime, and migration read array-ness
   (and every other structural concept) from the structural keyword/property — never from an
   attribute. No "accept either form" compatibility shims.

## Consequences

- **Conformance corpus:**
  - New shared error code **`ERR_RESERVED_ATTR`** in `fixtures/conformance/ERROR-CODES.json`.
  - New error fixture (e.g. `error-reserved-word-as-attr`) asserting `@isArray` → `ERR_RESERVED_ATTR`.
  - `origin-collection-simple` corrected from `@isArray` to bare `isArray`; its `expected.json`
    regenerated (the field now carries the structural array flag, as intended).
- **Every parser** adds one check in its `@`-key handling: if the de-sigiled name is in the
  reserved set, emit `ERR_RESERVED_ATTR` instead of creating an attribute. Small, local, and
  identical in spirit across TS / Python / C# / Java.
- **Codegen** drops any "either form" array detection and reads the structural property only.
- **Authoring** gets a loud, early error instead of a silent footgun (a field that *looks*
  marked as an array but isn't).
- **Back-compat:** any existing metadata using `@<reserved>` now fails to load. This is
  intended — such documents were already semantically wrong. Only the one in-repo fixture is
  affected; downstream consumers using the documented bare form are unaffected.

## YAML (both renderings — "one structure, two renderings")

JSON and YAML authoring funnel through the **same** `buildTree`/`parser-core`, and the
`ERR_RESERVED_ATTR` check lives there (not in the JSON front-end), so **this rule applies
identically to YAML**. Two YAML specifics:

- **Arrays are the idiomatic `[]` key-suffix sugar.** The YAML desugar turns `field.object[]:`
  into the reserved structural `isArray: true`. So YAML authors express collections with no
  sigil and never write `@isArray` — naturally compliant.
- **An `@`-prefixed key must be quoted in YAML** (`"@table": products`), because `@` is a YAML
  reserved indicator. This is functional, but across the attr-heavy source-v2 / persistence
  designs (`@table`, `@kind`, `@role`, `@onDelete`, …) it's verbose.

**Open question (deferred, not part of this ADR's core rule):** add a *fifth* YAML desugar rule
so inline attributes may be written **bare** in YAML — the desugar prefixes `@` to any key not
in the reserved set (the set is closed and known to the registry), keeping YAML clean
(`table: products`) while the canonical form keeps the `@` distinction. This would make YAML
first-class-ergonomic without weakening the namespace rule. Flagged for decision; **YAML
conformance fixtures** (the corpus is JSON-only today) should land with it.

## Alternatives considered

- **Normalize silently** (`@isArray` → bare `isArray`). Rejected: it keeps two accepted
  spellings for one concept, which is the incoherence we are removing; `@` would no longer be
  *exclusively* the attribute namespace.
- **Warn and normalize.** Rejected: softer, but still blesses the wrong form and complicates
  the canonical contract with a warning. The rule is simple enough to enforce strictly.
- **Array as a distinct type** (JSON-Schema style `type: array` + items). Rejected: MetaObjects
  is committed to the typed-field-plus-modifier model (Protobuf `repeated` lineage); reworking
  it would be a far larger remodel for no expressive gain here.

## Realization status

- **Spec:** `spec/wire-format.md` already states the rule; this ADR elevates it to an enforced,
  cross-cutting contract and adds the `ERR_RESERVED_ATTR` enforcement requirement.
- **TypeScript:** _pending this change._
- **Python:** _pending this change._
- **C#:** _pending this change._
- **Java:** _pending this change._

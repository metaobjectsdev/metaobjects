# Abstracts and inheritance

Metadata can declare **abstract** instances — nodes that describe a shape but
are never instantiated themselves. Concrete instances reference an abstract
via `extends:` to inherit its children and attrs. This is the **author-side**
mechanism for reuse: no provider code, no new subtype, no codegen change.

Abstracts and `extends:` are the lightest possible way to share metadata
shape. When you find yourself copy-pasting the same field/validator combo
across multiple entities, an abstract is the right answer.

For the **provider-side** mechanism (adding brand-new subtypes or
attributes), see [`extending-with-providers.md`](extending-with-providers.md).
The decision table at the bottom of this page compares both.

## What is an abstract?

An **abstract node** is any metadata node with `abstract: true`. It loads
normally but the loader / codegen treat it specially:

- It contributes shape but is **never emitted as a concrete entity** — no
  table, no API endpoint, no runtime class. Codegen skips it.
- It **cannot be instantiated directly** — every concrete instance must
  declare its own `name` and reference the abstract via `extends:`.
- It can be `extended` by any number of concrete instances, which all inherit
  its children + attrs.

`abstract` and `extends` are **structural keys** (bare, no `@` prefix) — the
same kind as `name`, `package`, `children`. They live alongside the node's
type/subtype, not as `@`-prefixed attributes.

## Two canonical use cases

### 1. Shared base entities (`object.entity` abstracts)

Common audit fields (`id`, `createdAt`, `updatedAt`) belong on one abstract
entity that all concrete entities extend. Change them in one place; every
table updates on the next `meta gen`.

```yaml
# metaobjects/abstracts/meta-base-entity.yaml
metadata:
  package: acme
  children:
    - object.entity:
        name: BaseEntity
        abstract: true
        children:
          - field.long:
              name: id
          - field.timestamp:
              name: createdAt
              "@required": true
          - field.timestamp:
              name: updatedAt
```

```yaml
# metaobjects/meta-author.yaml
- object.entity:
    name: Author
    extends: BaseEntity
    children:
      - source.rdb: { "@table": authors }
      - field.string:
          name: name
          "@required": true
      - identity.primary: { "@fields": id }
```

The codegen emits `authors` with `id`, `created_at`, `updated_at`, AND
`name` columns. `BaseEntity` itself is never a table — it has no
`source.rdb`, no identity, and `abstract: true`.

This is the pattern entities.md introduces — see
[`entities.md § extends`](entities.md#extends-for-shared-abstract-bases) for
the full Author example with per-port emission.

### 2. Shared field shapes (`field.<subtype>` abstracts)

When the same constraint set shows up on multiple entity fields — e.g., a
URL-safe opaque slug ID — declare it as an abstract field once.

```yaml
# metaobjects/abstracts/meta-slug-fields.yaml
metadata:
  package: acme
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
# metaobjects/meta-council.yaml
- object.entity:
    name: Council
    children:
      - source.rdb: { "@table": councils }
      - field.string:
          name: id
          extends: shortSlug    # ← inherits maxLength + regex + required
      - identity.primary: { "@fields": id }
```

Every port's codegen propagates the constraint:

- Drizzle column: `text("id").notNull()` + a CHECK constraint matching the
  regex
- Zod validator: `z.string().length(8).regex(/^[A-Z2-9]{8}$/)`
- Migration SQL: `CHECK (length(id) = 8 AND id REGEXP '^[A-Z2-9]{8}$')`

Change the alphabet or length in `shortSlug` once; every field that extends
it updates on the next regen. **No provider code, no codegen change in MO
itself — pure authored metadata.**

## How resolution works

The loader runs in passes (see [`loaders.md`](loaders.md)):

1. **Parse** every metadata file in deterministic ordinal order.
2. **Build tree** — every node exists in memory with its declared shape.
3. **Resolve `extends`** — walk every node; if it has `extends: "<name>"`,
   look up that name in the loaded tree (current package first, then via
   fully-qualified ref). Merge the abstract's children + attrs into the
   concrete node.
4. **Validate** — the merged node is checked against its subtype's rules
   (required attrs, child constraints, etc.) just like a flat node would be.

This means:

- **Abstracts can live in any file** in the corpus. The loader sees the
  whole tree before resolving extends — order doesn't matter.
- **Forward references are fine.** A field that `extends: shortSlug` can
  appear in a file the loader processes before the file that declares
  `shortSlug`.
- **Dotted refs to inherited members resolve in any order.** A field
  `extends: Owner.member` works even when `member` reaches `Owner` only
  through `Owner`'s own `extends:`. Super-resolution wires the owner's chain on
  demand before reading its effective members, so file/enumeration order never
  changes the result (#188).
- **Multi-level chains work.** `Author extends BaseEntity extends Auditable`
  flattens to one effective shape. Each level can add children or override
  attrs.
- **Cross-package references** use fully-qualified names:
  `extends: "shared::auditable"`. Same-package references can use the bare
  name.

If `extends:` references a name that doesn't resolve, the loader emits
`ERR_UNRESOLVED_SUPER` with the unresolved reference and the source location.
The fixture
[`extends-nonexistent`](../../fixtures/conformance/error-extends-nonexistent/)
covers this.

## Discriminator-based inheritance (TPH) with persistence

The two use cases above share *shape* — an abstract contributes columns to its
extenders, but each extender is still its **own** table. **Table-per-hierarchy
(TPH)** inheritance is the persistence-bearing form: several concrete entities are
variants of one thing and **share a single physical table**, told apart by a
**discriminator** column.

Declare it with two attributes:

- On the **base** entity, `@discriminator` names the discriminator field — a
  `field.enum` whose `@values` are the subtype tags.
- On each concrete **subtype**, `extends` the base and `@discriminatorValue` gives
  the tag (one of the base enum's members).

```yaml
metadata:
  package: acme::auth
  children:
    - object.entity:
        name: Auth                       # the TPH base — owns the single table
        "@discriminator": type
        children:
          - source.rdb: { "@table": auths }
          - field.long: { name: id }
          - field.enum:
              name: type
              "@values": ["Bridge", "Copay", "PriorAuth"]
          - field.string: { name: reference, "@required": true }
          - identity.primary: { "@fields": id }

    - object.entity:
        name: BridgeAuth                 # subtype → folded into `auths`
        extends: Auth
        "@discriminatorValue": Bridge
        children:
          - field.int: { name: quantity, "@required": true }

    - object.entity:
        name: CopayAuth
        extends: Auth
        "@discriminatorValue": Copay
        children:
          - field.decimal: { name: copayAmount, "@precision": 10, "@scale": 2 }

    - object.entity:
        name: PriorAuthAuth
        extends: Auth
        "@discriminatorValue": PriorAuth
        children:
          - field.string: { name: approver }
```

### Single-table persistence

Every subtype persists to the base's one table (`auths`). Subtype-only columns
(`quantity`, `copay_amount`, `approver`) are folded into that table **nullable** —
a row of any other subtype stores `NULL` there, **even when the field is
`@required`** on its subtype (a required rule can't hold across the shared table, so
it is dropped on the folded column; an enum `CHECK` still passes because `NULL IN
(...)` is `NULL`, not false). The base row shape is the **union** of all subtype
columns. Subtype entities emit **no** table of their own.

### What codegen emits (all five ports)

TPH is supported and conformance-gated in **all five ports** — codegen lowers it to
each port's idiomatic single-table mapping:

| Port | Single-table persistence | Polymorphic API |
|---|---|---|
| TypeScript | one Drizzle table (subtype cols nullable) + discriminated-union type + `parse<Base>` dispatcher | Fastify polymorphic + per-subtype routes; `runtime-ts` ObjectManager scopes by subtype |
| C# | EF Core `.HasDiscriminator(e => e.Type).HasValue<Sub>(...)` on the single table | ASP.NET minimal-API polymorphic + per-subtype routes |
| Java | union DTO (subtype cols nullable) + polymorphic / per-subtype-scoped repository seam | Spring Web MVC polymorphic + per-subtype controller |
| Python | Pydantic subtype pins the discriminator to a `Literal`; subtype-keyed repository `Protocol` | FastAPI polymorphic + per-subtype router |
| Kotlin | one Exposed `Table` (subtype cols `.nullable()`) + union data class | Spring polymorphic + per-subtype controller |

Where a port owns persistence (TS Drizzle, C# EF Core, Kotlin Exposed) the
single-table mapping is generated directly; where persistence is consumer-owned
(Java Spring, Python FastAPI) codegen emits the polymorphic controller/router plus a
subtype-scoped repository seam you implement (idiomatically a Spring-JPA
single-table mapping / a SQLAlchemy polymorphic mapping).

### Runtime behavior (the subtype contract)

The generated polymorphic surface enforces a consistent subtype contract across
every port:

- **Per-subtype route segment** = the `@discriminatorValue` **lowercased**:
  `/auths/bridge`, `/auths/copay`, `/auths/priorauth` (not the subtype entity
  name). There is intentionally **no polymorphic `POST /auths`** — you can't create
  the abstract base.
- **Create injects the discriminator** from the URL — `POST /auths/bridge` stamps
  `type = "Bridge"`; the request body omits it.
- **Reads/updates/deletes are scoped to the subtype** — `GET|PATCH|DELETE
  /auths/bridge/{id}` on a `Copay` row → **404** (a different-subtype row is
  invisible to a subtype-scoped operation).
- **The discriminator is immutable** — an update can't move a row to another
  subtype (the field is stripped from update patches).
- **Polymorphic reads** — `GET /auths` and `GET /auths/{id}` return the union across
  subtypes, each row tagged by its discriminator value.

### Conformance

- [`fixtures/api-contract-conformance/tph/`](../../fixtures/api-contract-conformance/tph/)
  pins the HTTP wire shape (polymorphic + per-subtype URLs, discriminator-by-value,
  cross-subtype 404), run in two lanes — a reference server AND the *generated*
  routes booted over HTTP.
- [`fixtures/persistence-conformance/`](../../fixtures/persistence-conformance/)
  `tph-*.yaml` scenarios pin the single-table runtime semantics (create injects the
  discriminator, subtype-scoped find, no cross-subtype update).

## Overlays vs. extends — different concepts

Both look like they're "merging shape" but they do different things:

| Mechanism | Purpose | Wire key |
|---|---|---|
| `extends:` | Concrete inherits from abstract — IS-A relationship | `extends: "BaseName"` |
| `overlay:` | Re-open an existing same-named node and add/override children — same-instance amendment across files | `overlay: true` |

Use `extends:` when two distinct entities share a shape. Use `overlay:` when
the same entity's declaration is split across files (e.g., domain code in
one file, persistence overlay in another). See
[`loaders.md`](loaders.md) for the overlay merge semantics.

## When to use abstracts vs. new subtypes vs. attr extensions

This is the same decision as
[`extending-with-providers.md § When to add a subtype vs. an attr vs. an
abstract`](extending-with-providers.md#when-to-add-a-subtype-vs-an-attr-vs-an-abstract),
viewed from the metadata author's side:

### Use **abstracts + `extends`** when:

- ✅ Multiple metadata instances should share a constraint set that changes
  together (slug shape across entities; audit columns across tables).
- ✅ The shape is expressible in existing subtypes — you don't need new
  attrs or new node classes.
- ✅ The author wants to opt into the shape per-instance (a Council `id`
  field extends `shortSlug`; a non-shareable Internal `id` doesn't).
- ✅ Zero code changes needed in MO itself.

### Use **attr extension** (via a provider's `registry.extend`) when:

- ✅ You need a new **configuration knob** that applies wherever an existing
  subtype is used (`@toolName` on `template.output`; `@audit-trail` on
  `field.*`).
- ✅ The attr is universally accepted — every instance of that subtype CAN
  set it, even if most don't.
- ✅ Codegen needs to branch on the attr's presence (e.g., emit a tool-call
  wrapper if `@toolName` is set).

### Use **new subtype registration** (via a provider's `registry.register`) when:

- ✅ The new concept needs a **different runtime node class** (different
  `factory:` returning a subclass of `MetaData`).
- ✅ It needs **different `childRules`** that can't be expressed as
  additional attrs (e.g., `source.rdb` accepts `@table`/`@kind`/`@role`
  but not arbitrary attrs).
- ✅ The concept is so universal it deserves a name in the closed core
  vocabulary — added to one of the core providers, not consumer-local.

### Decision flow

```
Need to share shape across multiple instances?
   ├─ YES → Is the shape expressible with existing subtypes?
   │        ├─ YES → Abstract + extends                       ← lightest
   │        └─ NO  → New attrs on existing subtype (extend)
   │                  ├─ Configuration only?       → registry.extend
   │                  └─ Structural divergence?    → registry.register
   └─ NO  → Don't make it shareable. Author it directly.
```

The marginal cost goes up sharply at each step:
**abstract (free) < attr-extension (cheap) < subtype-registration (expensive)**.
A new subtype is a permanent commitment in every port's registry; an
abstract is pure data the loader resolves at parse time. **Default to the
lightest mechanism that fits.**

## What each port emits

Abstracts are **invisible to codegen output** — the loader merges them into
their extenders before any generator runs. Each port emits exactly what it
would emit for the merged shape, as if the author had written all the
inherited children and attrs inline.

Cross-port reading:

```ts
// TypeScript: the loader's effective view
import { MetaDataLoader } from "@metaobjectsdev/metadata";
const loader = await MetaDataLoader.fromDirectory("app", "./metadata");

const author = loader.metaObject("acme::Author");
// author.fields() includes "id" + "createdAt" + "updatedAt" (from BaseEntity)
// AND "name" (declared directly). The abstract origin is transparent.
```

```java
// Java
MetaObject author = loader.getMetaObjectByName("acme::Author");
// Same — author.getMetaFields() returns the merged set.
```

```python
# Python
author = loader.meta_object("acme::Author")
# author.fields() returns the merged set.
```

The `extends:` chain itself is queryable via `node.superRef` (TS / Python)
/ `node.getSuperRef()` (Java / C#) for tooling that needs to walk the
inheritance chain.

## Verified by

- [`extends-single-level`](../../fixtures/conformance/extends-single-level/) — one
  level of inheritance, basic resolution
- [`extends-multi-level`](../../fixtures/conformance/extends-multi-level/) — A
  extends B extends C, full chain flattening
- [`extends-cross-file`](../../fixtures/conformance/extends-cross-file/) — forward
  reference across files
- [`extends-dotted-inherited-member-load-order`](../../fixtures/conformance/extends-dotted-inherited-member-load-order/)
  — a dotted `extends:` to a member the owner reaches only through its own
  `extends:` resolves regardless of file order (load-order-independent
  super-resolution, #188)
- [`extends-abstract-base`](../../fixtures/conformance/extends-abstract-base/) —
  abstract entities aren't instantiable; codegen skips them
- [`error-extends-nonexistent`](../../fixtures/conformance/error-extends-nonexistent/)
  — `ERR_UNRESOLVED_SUPER` when the reference doesn't resolve
- [`enum-abstract-extends`](../../fixtures/conformance/enum-abstract-extends/) —
  abstracts on enum fields specifically

## See also

- [`entities.md`](entities.md) — the canonical `BaseEntity` extends example
- [`extending-with-providers.md`](extending-with-providers.md) — the
  provider-side reference (when abstracts aren't enough)
- [`field-types.md`](field-types.md) — the field subtypes you can abstract over
- [`loaders.md`](loaders.md) — load order, deferred resolution, overlay semantics

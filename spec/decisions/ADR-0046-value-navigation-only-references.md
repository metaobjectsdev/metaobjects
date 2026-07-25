# ADR-0046: Value objects may carry navigation-only (`@enforce: false`) references

## Status

**Accepted** (2026-07-25). Extends [ADR-0028](ADR-0028-object-taxonomy-projection-value-purity.md)
point 2 ("`object.value` … no identity, no source, ever"). Resolves
[#238](https://github.com/metaobjectsdev/metaobjects/issues/238). No new vocabulary
(ADR-0037 step 0 — a child-licensing relaxation, not an expansion).

## Context

A non-persisted shape — an API DTO, an event payload, a wire-protocol command
message — frequently needs to say *"this field references entity X."* An
`AskForStake` message carries a `tableId` that references `Table`; a `TableState`
carries a `gameHandId` referencing `GameHand`. These are genuine references — a
dangling target should fail the load, and codegen should be able to type/navigate
them — but the shape is **neither persisted nor identity-bearing.**

The `value`↔`entity` dichotomy (ADR-0028) had no slot for this:

- `object.value` → refuses **all** identity/reference constructs (value purity —
  `subtype-rules.ts`: "value objects MUST NOT have ANY identity"; `ERR_SUBTYPE_RULE_VIOLATION`).
- `object.entity` → forces a writable `source` + primary identity the message
  does not have.
- `relationship.association` on a value → names the *target* entity but not *which
  field carries the foreign key*.

ADR-0028's purity doctrine is about **identity and storage** — a value owns no
identity of its own and is never populated from a source. But **referencing another
entity by id is neither.** A DTO that carries `tableId` and declares it references
`Table` stores nothing, owns no key, and has no source; it needs only a
*navigation-only, non-enforced* reference so the loader resolves the target (failing
on dangling) and codegen can type it. Purity bans a value's **own** identity and
its **storage**, not an **outbound** pointer.

The chartered construct for exactly "a reference the backend does not physically
enforce" already exists: `identity.reference @enforce: false`
(`identity-definition.embedded.ts` — *"Set false to declare a logical reference for
navigation/typing/codegen only — the value may dangle at the backend level."*). Its
`@references` target already resolves generically in the registry-derived validation
pass (`ERR_INVALID_REFERENCE` on a dangling target), and codegen already skips FK
emission when `@enforce` is false (`drizzle-schema.ts`: `if (!ref.enforce) continue`).
So the fix adds **zero** vocabulary and zero new resolution/codegen machinery — it
only relaxes a licensing rule.

## Decision

**`object.value` may carry an `identity.reference` child, and only when it declares
explicit `@enforce: false`.** The refined value child-licensing rule
(`validateValuePurity`, all four loader ports — TS/Java/Python/C#):

| Child on a value | Verdict |
|---|---|
| `identity.primary` | error `ERR_SUBTYPE_RULE_VIOLATION` (a value owns no identity) |
| `identity.secondary` | error `ERR_SUBTYPE_RULE_VIOLATION` (a value owns no key) |
| `identity.reference` **with `@enforce: false`** | **allowed** — navigation-only |
| `identity.reference` with `@enforce` true/absent | error `ERR_SUBTYPE_RULE_VIOLATION` — a value has no table to hang a physical FK on; add `@enforce: false` |
| `source.*` | error `ERR_SUBTYPE_RULE_VIOLATION` (a value is never persisted) |

**Why require *explicit* `@enforce: false`** rather than defaulting it to false on
values: `@enforce` defaults to `true` (a hard FK) everywhere else, and a hard FK on a
non-persisted shape is nonsensical — there is nothing to enforce it against. Making
the author write `@enforce: false` keeps the attribute's meaning uniform across hosts
(ADR-0037: "never a default that varies by context") and makes the navigation-only
intent self-documenting at the declaration site. A bare `identity.reference` on a
value is therefore an error that names its own fix.

**What stays true.** Value purity is unchanged in substance: a value still owns no
identity (`primary`/`secondary` remain banned) and is never persisted (`source`
remains banned). The relaxation admits only an *outbound, non-enforced* pointer —
which the metamodel already models and which is not "identity" in the purity sense.

```yaml
object.value:
  name: AskForStake
  children:
    - field.long: { name: tableId }
    - identity.reference:
        name: tableRef
        fields: [tableId]
        references: gaming::poker::Table
        enforce: false            # navigation-only — no FK, may dangle at the backend
```

## Consequences

- **No registry change.** `registry-conformance` is unaffected — no type, subtype, or
  attribute is added. This is the ADR-0028 point-5 "child-licensing is definitional,
  not computable" lever pulled in the *permissive* direction for one (subtype ×
  child-subtype × attr) combination.
- **Loader resolution is free.** A value's `identity.reference @enforce:false`
  resolves its `@references` target through the same registry-derived descriptor as
  an entity's; a dangling target fails with `ERR_INVALID_REFERENCE`, no new pass.
- **Codegen emits no FK/DDL.** A value has no source, so no table generator processes
  it; and FK emission is already gated on `@enforce`. A value's reference is
  navigation/typing metadata only.
- **Cross-port, all-or-nothing.** The four metamodel-loader ports (TS/Java/Python/C#)
  relax the rule together, gated by shared conformance fixtures — a value with an
  `@enforce:false` reference that must LOAD + resolve, a dangling one that must FAIL
  (`ERR_INVALID_REFERENCE`), and an enforced/bare one that must FAIL
  (`ERR_SUBTYPE_RULE_VIOLATION`). Kotlin consumes the JVM loader unchanged.
- **The M:N junction guard is now explicit.** Before this ADR, value purity's blanket
  ban on references *implicitly* guaranteed that an M:N `@through` junction (which must
  declare two `identity.reference` children) was an `object.entity` — a value could never
  hold the references. Admitting navigation-only references on values removes that implicit
  guard, so the `@through` validation now **explicitly** asserts the resolved junction is
  `object.entity` (`ERR_INVALID_RELATIONSHIP` otherwise) in all four ports. A junction is a
  physical join table; a value/projection has no table to join through. Gated by the
  `error-m2m-through-value` fixture.
- **The "new subtype" alternative is deferred, not chosen.** A dedicated
  `object.message`/`object.dto` subtype (issue #238 shape 2) is heavier (new
  vocabulary, new licensing regime) and unnecessary: a referencing DTO *is* a value
  with an outbound pointer. Adopters who want a distinct nominal type may still
  register their own provider subtype; core models the capability on `object.value`.
- **A field-level `@references` attribute is not chosen** (issue #238 shape 1b): it
  would add new vocabulary (ADR-0023 weight) and duplicate the FK-direction binding
  that `identity.reference @fields` already expresses. Reusing `identity.reference`
  keeps a value's reference declaration identical in shape to an entity's.

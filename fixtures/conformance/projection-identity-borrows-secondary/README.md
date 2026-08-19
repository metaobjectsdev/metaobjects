# projection-identity-borrows-secondary (#310)

A projection's `identity.primary` extends the entity's **`identity.secondary`**.

`Account` has a surrogate auto-increment `identity.primary` AND a unique business key
(`byCode`, over `tenant` + `code`). The read model keys off the business key and
**deliberately never surfaces the surrogate `id` at all** — the shape an adopter needs for a
read-only API view addressed by a code or slug rather than an internal database id.

## Why this must load

The loader required a dotted `extends` target to have the same type *and subtype*, so this
failed with `ERR_EXTENDS_TARGET_MISMATCH` — while the shipped, byte-gated registry text for
`object.projection` says, in both its `description` and its `rules`:

> Identity is optional and, when present, MUST extend **an entity identity**.

Not "an entity's PRIMARY identity". An `identity.secondary` is an entity identity, so the
loader was stricter than the contract it ships in every port.

**ADR-0040 is what makes the rule statable.** It moved uniqueness into the TYPE:
`identity.primary` and `identity.secondary` are both unique keys (`@unique` was *removed*
from secondary precisely because the subtype already says so), while `identity.reference` is
a foreign key and carries no uniqueness. So a key may borrow any UNIQUE key — borrowing a
key borrows uniqueness, not the entity's choice of which one is its main handle.

The bound matters as much as the grant: `identity.primary` extending an `identity.reference`
is still refused, because an FK cannot back a key. That negative is pinned per-port rather
than here, since this corpus's `expected-errors.json` shape covers one load at a time.

## Provenance of the rule this relaxes

The subtype half of the gate was never written for identities. Its only conformance byte is
`error-extends-entity-field-type-mismatch` — a `field.uuid` extending a `field.string`. For a
FIELD, subtype IS the datatype and inheriting across it is incoherent; for an identity,
subtype is a ROLE. A field-shape rule was generalized onto a role axis without a fixture ever
exercising it.

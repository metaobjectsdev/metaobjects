# Migration — `@readOnly` becomes `@mutability` (`0.24.0` / Maven `7.24.0`)

**Breaking.** The boolean `@readOnly` is retired on every `field.*` subtype (18 registry
entries) and replaced by a three-mode enum.

| retired | now fails with |
|---|---|
| `@readOnly: true` / `@readOnly: false` | `ERR_UNKNOWN_ATTR` |

Under the strict, sealed registry (ADR-0023) there is no deprecation shim — metadata still
carrying it fails the **load**, in every language port.

## The rewrite

```jsonc
{ "field.timestamp": {
    "name": "createdAt",
-   "@readOnly": true
+   "@mutability": "readOnly"
}}
```

```jsonc
{ "field.string": {
    "name": "label",
-   "@readOnly": false        // delete it outright — readWrite is the default
}}
```

That is the whole mechanical migration. `grep -rn "@readOnly" <your metadata dir>` gives the
exact count; the load fails on the first one, so there is no partial-adoption state.

**Measured cost:** across three adopting estates — 826, 8 and 75 metadata files, **14,860
`field.*` nodes** — the attribute is used **zero** times. Two independent counting methods
(a structured walk of every field node, and a raw grep) agree, with controls confirming the
method finds `@autoSet` and `identity.primary` in the same trees. If your estate is like
those, this migration is empty. The attribute's heaviest use was in this library's own
conformance corpus.

## Why an enum, and not a second boolean

The change exists because a real modelling need had no expression: **"set once on create,
never changed afterwards."** An assigned primary key is the clearest case — the caller must
supply it, and must never be able to change it.

`@readOnly: true` cannot say that (it means *never* settable, so the row could not be
created), and `@readOnly: false` cannot either. Adding a second `@writeOnce` boolean would
make `@readOnly: true` + `@writeOnce: true` **representable and meaningless**.

`readOnly` and `writeOnce` are mutually exclusive modes of ONE axis — *who may write, and
when* — so they belong in one enum. That makes the illegal pair unrepresentable and gives
inheritance a total order.

| `@mutability` | supplied by | POST | PATCH |
|---|---|---|---|
| `readWrite` (default, absent) | caller | yes | yes |
| `writeOnce` | caller | yes | **no — excluded from the settable set** |
| `readOnly` | nobody | no | no |

`@autoSet` is the neighbouring, DIFFERENT axis — *the server* supplies the value:

| declaration | supplied by | POST | PATCH |
|---|---|---|---|
| `@autoSet: onCreate` | server | no | no |
| `@autoSet: onUpdate` | server | no | no |

## What `writeOnce` does to your generated API

A `writeOnce` field is **present in the create shape and absent from the update shape** —
`<Entity>InsertSchema` but not `<Entity>UpdateSchema`, `<Entity>Create` but not
`<Entity>Patch`, `<Entity>Dto` but not the patch settable set, and (C#) a public setter
plus `SetAfterSaveBehavior(Ignore)`.

**A value presented for it on PATCH is STRIPPED, not rejected — you get a `200`, not a
`400`, and the stored value is unchanged.** Two reasons, and the second is the decisive one:

1. It is the uniform behaviour of every key excluded from the settable set on this path —
   the TPH discriminator and `@autoSet: onCreate` both behave exactly this way today.
2. **The generated edit form submits EVERY registered field.** `handleSubmit` passes all
   values, and 0.19.2 switched the form resolver to `UpdateSchema` on edit rather than
   diff-and-omit. Rejecting a present-but-frozen key would therefore fail *every save on
   every generated edit form* for an entity carrying one.

Clearing counts as a write, so the FR-035 present-null path does not reach a `writeOnce`
column either: sending `"issuedCurrency": null` leaves the stored value alone.

## New load errors

### `ERR_MUTABILITY_AUTOSET_CONFLICT`

`@autoSet` together with `@mutability: "writeOnce"` or `"readOnly"`. The two attributes then
say contradictory things about one column: `@autoSet` means *the server supplies this*,
`@mutability` says *who may write it*.

```jsonc
{ "field.timestamp": {
    "name": "createdAt",
    "@autoSet": "onCreate",
-   "@mutability": "readOnly"     // ERR_MUTABILITY_AUTOSET_CONFLICT — drop this line
}}
```

Drop the `@mutability`: an `@autoSet` field is already excluded from every input shape, so
it adds nothing. **In the three estates scanned above this rule has zero existing instances**
— it is purely forward-looking, and that is a different claim from "we did not look."

Worth knowing why it is new: the boolean era left `@readOnly: true` + `@autoSet` fully
**representable and entirely unvalidated**. The enum closes both arms with one rule.

### `ERR_MUTABILITY_DOWNGRADE` (replaces `ERR_READONLY_DOWNGRADE`)

A subtype may **tighten** an inherited mode and never loosen it:

```
readWrite  <  writeOnce  <  readOnly
```

So `readWrite → readOnly` is fine, and `readOnly → writeOnce` is an error. The code was
renamed because the rule now spans three modes — a code named `READONLY` would misdescribe a
`writeOnce → readWrite` loosening.

### `ERR_READONLY_ASSIGNED_PRIMARY` — unchanged name, and note the asymmetry

`@mutability: "readOnly"` on a field targeted by an `identity.primary` with
`@generation: "assigned"` is still an error: nothing could ever populate the key.

**`@mutability: "writeOnce"` on that same key is LEGAL, and is the natural declaration for
it.** That asymmetry is the enum's whole justification, and it is why this code keeps its
readOnly-specific name.

```jsonc
{ "object.entity": { "name": "Ledger", "children": [
    { "field.string": { "name": "id", "@mutability": "writeOnce" } },
    { "identity.primary": { "name": "id", "@fields": "id", "@generation": "assigned" } }
]}}
```

### Two new warnings (not errors)

- **`WARN_MUTABILITY_VALUE_OBJECT`** (replaces `WARN_READONLY_VALUE_OBJECT`) — a non-default
  mode on an `object.value` field. A value has no persistence semantics, so the contract is
  advisory; codegen may still use it for record/struct treatment.
- **`WARN_MUTABILITY_READONLY_HOST`** — `writeOnce` on a host nothing writes (a projection,
  or a read-only source `@kind`). Benign: the declaration is inert, not wrong, and a
  projection may legitimately inherit it from the entity it extends.

## No churn if you declare nothing

Metadata with no `@mutability` generates byte-identically to before, and an explicit
`@mutability: "readWrite"` emits byte-identically to declaring nothing at all — pinned by
tests in the TypeScript and C# ports.

# MetaObjects Metamodel

The MetaObjects metamodel is built from 11 base types:

- `metadata` — root wrapper (subtype: `root`)
- `object` — typed entity (subtypes: `base`, `entity`, `value`, `projection`)
- `field` — entity field (subtypes: `string`, `int`, `long`, `boolean`, `date`, `currency`, etc.)
- `attr` — named attribute (subtypes by value type)
- `validator` — field-level validation rules (subtypes: `required`, `length`, `regex`, etc.)
- `view` — UI rendering hints (subtypes: `text`, `dropdown`, `currency`, etc.) — attaches to fields
- `layout` — object-level UI surfaces (subtypes: `dataGrid`, etc.)
- `identity` — primary + secondary keys (subtypes: `primary`, `secondary`, `reference`)
- `relationship` — associations between objects (subtypes: `association`, `composition`, etc.)
- `source` — storage backend (subtype: `rdb`, with `@kind`: `table` | `view` | `materializedView` | `storedProc` | `tableFunction`; read-only-ness is derived from `@kind`)
- `origin` — field provenance (subtypes: `passthrough`, `aggregate`)

Each type has subtype-specific child rules + attrs.

## Node encoding — fused-key form

Every metadata node is a one-key map of the shape `{ "<type>.<subType>": <body> }`. The
wrapper key fuses type and subType; there is no separate `subType` body key. Examples:

- `metadata.root` — the root wrapper
- `object.entity`, `object.value`, `object.projection`, `object.base`
- `field.string`, `field.long`, `field.currency`
- `identity.primary`, `identity.secondary`
- `relationship.association`
- `source.rdb`
- `origin.passthrough`, `origin.aggregate`

Inside each node body, the **reserved structural keys** are exactly:

- `name` — string (when non-empty)
- `package` — string (root and any node that sets one)
- `extends` — string (super reference, when set)
- `abstract` — `true` (when the node is abstract)
- `overlay` — `true` (when the node re-opens an existing same-named node)
- `isArray` — `true` (when the node is an array; structural, NOT an `@`-attr)
- `children` — list of nodes (when non-empty)

Everything else inside a body is an `@`-prefixed attribute (e.g. `@column`, `@currency`,
`@fields`). `@`-attrs appear in alphabetical order in the canonical form.

**Singleton default-naming.** A type may declare itself a singleton (`maxOccurs: 1`)
with a `defaultName`. A name-less node of such a type is named from `defaultName` by
the loader and serialized with that name; a second occurrence under the same parent is
an `ERR_TOO_MANY_OCCURRENCES` error. `identity.primary` is the canonical case
(`defaultName: "primary"`), so `{ "identity.primary": { "@fields": "id" } }` is a
complete, loadable node — the name is optional. This is a generic registry rule, not a
per-type loader special-case, and is gated cross-port by the
`identity-primary-default-name` / `error-too-many-primary` conformance fixtures.

See `typescript/packages/metadata/src/constants.ts` for the canonical vocabulary
(type names, subtype names, structural keys, separators).

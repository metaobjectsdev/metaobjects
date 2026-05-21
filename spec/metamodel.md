# MetaObjects Metamodel

The MetaObjects metamodel is built from 11 base types:

- `metadata` — root wrapper (subtype: `root`)
- `object` — typed entity (subtypes: `base`, `entity`, `value`)
- `field` — entity field (subtypes: `string`, `int`, `long`, `boolean`, `date`, `currency`, etc.)
- `attr` — named attribute (subtypes by value type)
- `validator` — field-level validation rules (subtypes: `required`, `length`, `regex`, etc.)
- `view` — UI rendering hints (subtypes: `text`, `dropdown`, `currency`, etc.) — attaches to fields
- `layout` — object-level UI surfaces (subtypes: `dataGrid`, etc.)
- `identity` — primary + secondary keys (subtypes: `primary`, `secondary`, `reference`)
- `relationship` — associations between objects (subtypes: `association`, `composition`, etc.)
- `source` — storage backend (subtypes: `dbTable`, `dbView`)
- `origin` — field provenance (subtypes: `passthrough`, `aggregate`)

Each type has subtype-specific child rules + attrs.

## Node encoding — fused-key form

Every metadata node is a one-key map of the shape `{ "<type>.<subType>": <body> }`. The
wrapper key fuses type and subType; there is no separate `subType` body key. Examples:

- `metadata.root` — the root wrapper
- `object.entity`, `object.value`, `object.base`
- `field.string`, `field.long`, `field.currency`
- `identity.primary`, `identity.secondary`
- `relationship.association`
- `source.dbTable`, `source.dbView`
- `origin.passthrough`, `origin.aggregate`

Inside each node body, the **reserved structural keys** are exactly:

- `name` — string (when non-empty)
- `package` — string (root and any node that sets one)
- `extends` — string (super reference, when set)
- `abstract` — `true` (when the node is abstract)
- `overlay` — `true` (when the node re-opens an existing same-named node)
- `isArray` — `true` (when the node is an array; structural, NOT an `@`-attr)
- `children` — list of nodes (when non-empty)

Everything else inside a body is an `@`-prefixed attribute (e.g. `@dbColumn`, `@currency`,
`@fields`). `@`-attrs appear in alphabetical order in the canonical form.

See `typescript/packages/metadata/src/constants.ts` for the canonical vocabulary
(type names, subtype names, structural keys, separators).

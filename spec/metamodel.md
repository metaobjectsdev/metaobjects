# MetaObjects Metamodel

The MetaObjects metamodel is built from 9 base types:

- `metadata` — root wrapper
- `object` — typed entity (subtypes: `base`, `entity`, `value`)
- `field` — entity field (subtypes: `string`, `int`, `long`, `boolean`, `date`, `currency`, etc.)
- `attr` — named attribute (subtypes by value type)
- `validator` — field-level validation rules
- `view` — UI rendering hints (subtypes: `text`, `dropdown`, `currency`, etc.) — attaches to fields
- `layout` — object-level UI surfaces (subtypes: `dataGrid`, etc.)
- `identity` — primary + secondary keys
- `relationship` — associations between objects
- `source` — storage backend (subtypes: `dbTable`, `dbView`)
- `origin` — field provenance (subtypes: `passthrough`, `aggregate`)

Each type has subtype-specific child rules + attrs.

See `typescript/packages/metadata/src/constants.ts` for the canonical vocabulary (until this doc is filled in).

> Document under construction. Detailed semantics live in CLAUDE.md sections "Codegen architecture", "File organization", "URL prefix policy", and "Cross-language porting" until promoted here.

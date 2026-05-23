# Wire Format

The MetaObjects wire format is JSON. Metadata files live in `metaobjects/` at project root,
organized by domain concept (e.g., `meta.commerce.json`). Each file declares its package
on the root node.

## Canonical fused-key form

Every node is a one-key map: `{ "<type>.<subType>": <body> }`. The wrapper key fuses type
and subType — there is no separate `subType` body key.

```json
{
  "metadata.root": {
    "package": "myapp::commerce",
    "children": [
      {
        "object.entity": {
          "name": "Program",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "title" } },
            { "identity.primary": { "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
```

## Body key order

Within a node body, keys appear in this exact order in the canonical form:

1. `name` — when non-empty
2. `package` — when set
3. `extends` — when set
4. `abstract` — when `true`
5. `overlay` — when `true`
6. `isArray` — when `true`
7. inline attributes (bare) — alphabetical order within this section
   (e.g. `currency`, `default`, `fields`, `locale`, `objectRef`, `schema`)
8. `children` — when non-empty (declaration order, NOT alphabetized)

All keys are **bare — there is no `@` sigil** (ADR-0006). The reserved structural keywords are
exactly the closed set listed above (1–6, 8); **any other bare key is an inline attribute**.
Classification is reserved-set membership, so no marker is needed. An `@`-prefixed key is
rejected (`ERR_AT_PREFIX_KEY`) in every language port — keys are bare; write `schema`, not
`@schema`. Array-ness is the bare reserved `isArray` (or, in YAML, the `[]` key-suffix sugar);
never a sigiled key.

## Package + file organization

Multiple objects per file when they share a domain. Projections live inline with their
base entities. Files are scanned recursively under `metaobjects/`. Same-package +
same-name objects across files are merged by the Loader via overlay semantics.

```json
{
  "metadata.root": {
    "package": "myapp::commerce",
    "children": [
      { "object.entity": { "name": "Program", "children": [/* ... */] } },
      { "object.entity": { "name": "Purchase", "children": [/* ... */] } },
      { "object.entity": { "name": "ProgramSummary", "extends": "Program",
          "children": [/* ... */] } }
    ]
  }
}
```

## Attribute values

- `@fields` accepts a string in authoring (`"@fields": "id"`) but is normalized to an
  array in canonical (`"@fields": ["id"]`).
- Boolean attrs: `"@filterable": true`, `"@default": false`.
- Numeric attrs: `"@pageSize": 25`, `"@default": 0`.

See [`metamodel.md`](metamodel.md) for the type vocabulary and
[`conformance-tests.md`](conformance-tests.md) for the canonical serializer contract.

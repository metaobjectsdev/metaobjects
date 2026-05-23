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
6. `isArray` — when `true` (structural, NOT an `@`-attr)
7. `@`-prefixed attributes — alphabetical order within this section
   (e.g. `@currency`, `@dbColumn`, `@default`, `@fields`, `@locale`, `@objectRef`)
8. `children` — when non-empty (declaration order, NOT alphabetized)

The reserved structural keys are exactly those listed above. In **canonical JSON**, everything
else is an `@`-prefixed attribute; `@`-prefixing a reserved word (e.g. `@isArray`) is invalid
(`ERR_RESERVED_ATTR`). **YAML authoring is sigil-free** (ADR-0006): the same closed reserved set
is bare, every other key is a bare attribute, and the desugar re-adds the `@` when lowering to
this canonical form. Array-ness is the bare reserved `isArray` (YAML: the `[]` key-suffix sugar).

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

# YAML authoring

Canonical JSON is the on-disk interchange format — what conformance fixtures pin,
what loaders cross-port serialize byte-identical, what tooling that isn't a
MetaObjects port can still parse. **YAML is the universal authoring front-end** —
sigil-free, AI-friendly, and lowered to canonical JSON at load time so it shares
the entire downstream pipeline.

The full rationale is in
[ADR-0006](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md).

## The four desugar rules

YAML is desugared to canonical JSON inside the loader. The rules are pinned
cross-port in [`fixtures/yaml-conformance/`](../../fixtures/yaml-conformance/).

### Rule 1 — sigil-free attrs

Bare YAML keys are interpreted as attribute names. The desugar re-adds the `@`
prefix when lowering. Structural keywords (`name`, `package`, `extends`,
`abstract`, `overlay`, `isArray`, `children`, `value`) stay bare.

YAML:

```yaml
- field.string:
    name: sku
    column: sku_code
    required: true
    maxLength: 200
```

Canonical JSON:

```json
{ "field.string": {
    "name": "sku",
    "@column": "sku_code",
    "@required": true,
    "@maxLength": 200
}}
```

### Rule 2 — `[]`-array suffix

A field-subtype key with a trailing `[]` declares an array-valued field. The
desugar splits the suffix off and emits `"isArray": true`.

YAML:

```yaml
- field.long[]: weekIds
```

Canonical JSON:

```json
{ "field.long": { "name": "weekIds", "isArray": true } }
```

### Rule 3 — fused-key default subtype

If a key uses the bare type name without a subtype (e.g. `field:` instead of
`field.string:`), the desugar applies the default subtype for the type (`string`
for `field`, `entity` for `object`, etc.).

### Rule 4 — D2 type-coercion guard

YAML 1.2 implicit type-coercion (a bare `yes`/`no`/`on`/`off` parsing as boolean,
a bare `2026-05-25` parsing as a date) is the **single biggest source of subtle
authoring bugs**. The loader rejects coerced values in attribute positions that
declare a different `dataType`. The fixtures
`fixtures/yaml-conformance/error-yaml-coerced-bool-in-string` and
`error-yaml-coerced-num-in-enum` pin the behavior.

A coerced bool in a string slot:

```yaml
- field.string:
    name: status
    default: yes        # YAML parses this as `true`, not the string "yes"
```

…fails the load with a coercion-guard error. Fix by quoting:

```yaml
- field.string:
    name: status
    default: "yes"
```

## Authoring side-by-side

The same `Author` entity in YAML and canonical JSON.

### YAML

```yaml
metadata:
  package: acme::blog
  children:
    - object.entity:
        name: Author
        children:
          - source.rdb: { table: authors }
          - field.long:   { name: id }
          - field.string: { name: name, required: true, maxLength: 200 }
          - field.string: { name: bio, maxLength: 2000 }
          - identity.primary: { fields: id, generation: increment }
```

### Canonical JSON (auto-derived)

```json
{
  "metadata.root": {
    "package": "acme::blog",
    "children": [
      {
        "object.entity": {
          "name": "Author",
          "children": [
            { "source.rdb":   { "@table": "authors" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 200 } },
            { "field.string": { "name": "bio",  "@maxLength": 2000 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ]
        }
      }
    ]
  }
}
```

## Mixed-format directories

A single directory may freely mix `*.json` and `*.yaml` (or `*.yml`) files. The
loader picks both up, applies the same deterministic ordinal-filename sort, and
runs the same pipeline downstream. Overlay merge (a YAML file extending or
overriding a JSON-declared entity in the same package) works identically.

## Reserved-attr collision

`@`-prefixing a reserved structural keyword is invalid because it would collide
with the structural slot of the same name:

```yaml
- field.long:
    name: weekIds
    "@isArray": true        # ERR_RESERVED_ATTR — use the bare key `isArray` or the `[]` suffix
```

The right form is `isArray: true` (bare) or `field.long[]:` (suffix).

## What each port generates

The YAML desugar is a loader-only concern — no port-specific generated code
differs because of YAML vs JSON authoring. The downstream codegen sees the
canonical JSON tree and emits identical output regardless of which authoring
format the metadata was on disk in.

| Port | YAML loader support |
|---|---|
| TypeScript | Yes — `@metaobjectsdev/metadata` desugars at load |
| Java | Yes — `metaobjects-metadata` desugars at load |
| Kotlin | Yes — via the Java loader |
| C# | Yes — `MetaObjects.Loader` desugars at load (via `YamlDotNet`) |
| Python | Yes — `metaobjects.loader` desugars at load (via `PyYAML`) |

## See also

- [loaders.md](loaders.md) — the pipeline that consumes the desugared JSON
- [entities.md](entities.md) — the `object.entity` form in both formats
- [field-types.md](field-types.md) — the field subtypes you'll author most
- [ADR-0006](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md) — design rationale
- [`fixtures/yaml-conformance/`](../../fixtures/yaml-conformance/) — every desugar rule pinned cross-port

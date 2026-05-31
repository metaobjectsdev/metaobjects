# extract-conformance — FR-010 dirty-input corpus

Each `<case>/` has:
- `schema.json` — serialized ExtractSchema (format, rootName, fields[])
- `input.txt`    — the raw (deliberately dirty) model response
- `expected.json` — { empty, states{path:FieldExtraction}, data{field:canonicalValue} }

Every port's `extract` runs this corpus. The conformance assertion is on `empty` +
`states` (per-field classification) + `data` (canonical normalized values). Raw numeric
coercion carries a documented tolerance: ints exact, doubles within 1e-9. Classification
is byte-identical across ports; raw coercion is not required to be.

## `schema.json` field keys

Each `fields[]` entry: `name`, `kind` (`STRING|INT|LONG|DOUBLE|BOOLEAN|ENUM|OBJECT`),
`required` (bool). Kind-specific keys:

- `INT|LONG|DOUBLE` — optional `min` / `max` (clamp range).
- `ENUM` — `enumValues` (member symbols) plus the FR-011 coercion-pipeline keys:
  - `enumAlias` — `{ synonym: MEMBER }` (FR-010); keys matched under the field's mode.
  - `normalize` — `none | collapse | strip` (default `strip`). `strip` = ASCII case-fold +
    keep `[A-Z0-9]`; `collapse` = case-fold + collapse `[\s_-]+` to `_`.
  - `coerceDefault` — member used when a present value is otherwise uncoercible → `DEFAULTED`.
  - `default` — member used when the field is ABSENT → `DEFAULTED` (satisfies `required`).
- `OBJECT` — `array` (bool) plus `fields[]` (the nested schema). Sub-fields classify under
  dotted paths (`meta.score`, `items[0].label`). A nested object's own state is `EXTRACTED`
  when it parsed (children classified independently); scalar-where-object → `MALFORMED`.

FR-011 added the `enum-*`, `nested-object-*`, `array-of-objects`, `xml-nested`, and
`multi-malformation` cases on top of the original FR-010 ten.

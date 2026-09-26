# extract-conformance — FR-010 dirty-input corpus

Each `<case>/` has:
- `schema.json` — serialized ExtractSchema (format, rootName, fields[])
- `input.txt`    — the raw (deliberately dirty) model response
- `expected.json` — { empty, states{path:FieldExtraction}, malformedRequired?, data{field:canonicalValue} }

`malformedRequired` lists the `@required` fields (dotted paths, any order) whose state is
`MALFORMED` — present in the reply, but unusable. Every runner asserts it, and an absent key
means the empty list. It is the second half of the strict gate: a generated extractor, and
every port's `orThrow` / `dataOrThrow`, fail when `lostRequired` OR `malformedRequired` is
non-empty, so a garbled required value can never come back as `null` in a type that says it
is present. Array elements (`tags[0]`) carry no requiredness of their own; a `@required` array
with a malformed element is itself listed (`json-required-malformed`).

Every port's `extract` runs this corpus — with the JVM nuance that Kotlin does not
ship a separate extract engine: it drives the shared Java one (`metadata-ktx`), so a
Kotlin lane here is engine reuse rather than an independent implementation. The
conformance assertion is on `empty` +
`states` (per-field classification) + `data` (canonical normalized values). Raw numeric
coercion carries a documented tolerance: ints exact, doubles within 1e-9. Classification
is byte-identical across ports; raw coercion is not required to be.

## `schema.json` field keys

Each `fields[]` entry: `name`, `kind` (`STRING|INT|LONG|DOUBLE|BOOLEAN|ENUM|OBJECT`),
`required` (bool). Kind-specific keys:

> **The `kind` vocabulary is a cross-port contract, and it is now gated.** Those seven values
> are the coercion targets every port's extract engine understands, so a port that adds or
> drops one changes what this corpus can express while every existing case keeps passing —
> invisible drift by construction. It had already happened: C# carries a `Decimal` kind no
> other port has and no fixture exercises. The machine-readable set lives in
> [`expected-field-kinds.json`](expected-field-kinds.json), checked by
> `scripts/check-extract-field-kinds.mjs` in `ci-local.sh`'s `gates` lane, which reads each
> port's real definition rather than a copied list. Deviations pass only when that file
> records them with a stated reason; the C# one is recorded there along with why it was not
> simply deleted. Kotlin has no entry on purpose — it ships no extract engine, driving the
> shared Java one through `metadata-ktx`, so a Kotlin `FieldKind` would itself be the drift,
> and the gate fails if one appears.

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

#363 added the three `json-fence-after-*` cases, `json-fenced-example-then-answer` and
`json-shapeless-object-then-answer` cases: JSON selection searches fenced blocks first, then
the whole reply, and takes the first object carrying at least one declared field; only when
none does is the first object taken.

Three XML cases pin how the tolerant reader treats text that is not a clean scalar:
`xml-mixed-content-text-kept` (an element with both prose and child elements keeps its own
text under `#text`, so a scalar field reads the prose), `xml-element-into-scalar-malformed`
(an element with only child elements is `MALFORMED` for a scalar field, never a stringified
map), and `xml-unclosed-stray-close-tag` (an unclosed element's body ends at a close tag of
another element, which models often write instead of the right one).

The three `json-comment-*` cases pin comments in a JSON reply (models write JSONC): a `//`
line comment or a `/* */` block comment outside a string literal is skipped, including one
that holds a brace or a quote (`json-comment-line`), so no field after it is lost; comment
markers INSIDE a string literal are kept verbatim (`json-comment-markers-in-string`). The
strict parser does not change: only the tolerant recovery reads past comments.

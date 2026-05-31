# output-prompt-conformance

Pins the FR-010 output-format prompt fragment (`OutputFormatRenderer`) byte-identically
across all five ports. Each case directory holds:

- `spec.json` — a unified field descriptor (the cross-port oracle input).
- `expected.guide.txt`, `expected.inline.txt`, `expected.exampleOnly.txt` — byte-exact
  rendered fragments for the three `@promptStyle` values.
- `README.md` — what the case exercises.

Every port: parse `spec.json` → build native `OutputFormatSpec` → `render(spec, style)` for
each style → assert byte-equal to `expected.<style>.txt`. Zero-drift: no ledger; any
divergence fails the build. For `spec.json` with `"roundTrip": true`, also build a
`RecoverSchema` from the same descriptor and assert `recover(expected.exampleOnly.txt)`
classifies every field cleanly (no MALFORMED / LOST_*).

## `spec.json` schema

{ format: "json"|"xml", rootName: string, roundTrip?: boolean,
  fields: [ { name, kind: "STRING"|"INT"|"LONG"|"DOUBLE"|"BOOLEAN"|"ENUM"|"OBJECT",
              required: bool, array?: bool, example?: string|null,
              instruction?: string|null, enumValues?: string[]|null,
              enumDoc?: {member:doc}|null, nested?: <spec.json>|null } ] }

## No raw floats

Example values are restricted to strings, integers, booleans, and dyadic decimals
(e.g. 1.5, 0.125) only — never a raw float whose textual form differs across runtimes.
This keeps zero-drift robust against cross-runtime float formatting.

## Nested objects

A field with `kind: "OBJECT"` and a `nested` spec recurses: the renderer expands the
full nested shape across all three styles. JSON arrays render as `[ one example element ]`;
XML arrays show one representative element; in `guide`, nested fields appear with a dotted
path (`meta.score`, or `items[].label` for arrays). A depth/cycle guard falls back to the
flat `{name}` placeholder beyond `MAX_NEST_DEPTH` (or on a repeated spec in the path), so
the renderer never recurses unboundedly.

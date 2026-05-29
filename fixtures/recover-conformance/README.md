# recover-conformance — FR-010 dirty-input corpus

Each `<case>/` has:
- `schema.json` — serialized RecoverSchema (format, rootName, fields[])
- `input.txt`    — the raw (deliberately dirty) model response
- `expected.json` — { empty, states{path:FieldRecovery}, data{field:canonicalValue} }

Every port's `recover` runs this corpus. The conformance assertion is on `empty` +
`states` (per-field classification) + `data` (canonical normalized values). Raw numeric
coercion carries a documented tolerance: ints exact, doubles within 1e-9. Classification
is byte-identical across ports; raw coercion is not required to be.

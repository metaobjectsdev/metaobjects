# Decimal wire vectors

The shared vectors for the decimal wire rule, [ADR-0019 Amendment 1](../../spec/decisions/ADR-0019-runtime-return-type-contract.md#amendment-1-2026-10-21-the-decimal-wire-form).
Every port runs them in a unit test against its **production** wire helper (the code its
generated routes and DTOs call), not a copy written for the test. No database is involved: the
persistence corpus (`decimal-exact*` scenarios) and the api-contract `decimal/` sub-corpus gate
the read path and the HTTP bytes.

| Section | What the test does | Passes when |
|---|---|---|
| `format` | builds the port's exact value from `in` (`new BigDecimal(in)`, `decimal.Parse(in, NumberStyles.Float, CultureInfo.InvariantCulture)`, `Decimal(in)`, the string in TypeScript) and formats it for the wire (W1) | the output equals `out` byte for byte |
| `parse` | parses the JSON text `json` as a request-body value (W2) | the result equals `value` exactly (`compareTo == 0`, `==`, `Decimal ==`, canonical string equality in TypeScript), `null` for `null`, or the parse is refused when `error` is `true` |
| `filterOperand` | parses the query-string text `text` as a decimal filter operand (W2) | as `parse` |
| `double15` | renders the IEEE double written as `double` at 15 significant digits, then canonicalizes it (W4) | the output equals `out`; run by every port with a SQLite or D1 read path |

`1234567890123456789012345678` (28 digits) is the largest `format` value: it is inside C#'s
`decimal` range (W3). JSON-number inputs in `parse` have 15 significant digits or fewer, the
limit W2 guarantees for a number.

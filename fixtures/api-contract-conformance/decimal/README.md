# `api-contract-conformance/decimal/` — a decimal is exact on the wire (ADR-0019 Amendment 1)

Cross-port REST contract for `field.decimal`, over one writable entity (`Entry`, a
`decimal(28,10)` `amount`) and one served report (`EntryTotals`) read from it.

## The rule (W1 to W4)

- **W1, emit.** A decimal is a JSON **string** in canonical form, `^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$`:
  plain notation, no exponent, no trailing fraction zeros, zero as `"0"`. The server never formats
  a scale (`100.50` is stored; `"100.5"` is sent). The same holds for a report's decimal measures
  (a sum, an average, a maximum, a ratio) and for a `null`: `null` stays `null`.
- **W2, accept.** A request body carries a decimal as a string in the JSON-number grammar (an
  exponent is allowed: `"1.5e1"` is `15`) or as a JSON number. Anything else (`"12abc"`, `"NaN"`,
  `true`, an object) is `400 {"error": "validation"}`. A filter operand uses the same grammar and
  is compared **exactly**: `12345678901234567.89` and `12345678901234567.8` are different numbers
  though they are one double. A bad operand is `400 {"error": "invalid_filter_value", "field": ...}`.
- **W3, range.** A value the declared column cannot hold (more fraction digits than `@scale`, more
  integer digits than `@precision - @scale`) is `400 validation` on input. Nothing is rounded.
- **W4, floating engines.** SQLite and D1 have no decimal: they keep a double, which is exact to
  15 significant digits. A port on them renders a read at 15 significant digits, so `0.1 + 0.2` is
  `"0.3"`. They do not promise `12345678901234567.89`, and equality against a computed double
  (a view's sum) is not promised either, so the `-15` scenarios use ranges there.

## Scenarios

`engines:` is exact (see the persistence corpus README): a scenario with it runs only on the
listed engines; a scenario without runs on all four. A `-15` scenario is the subset of its twin
whose values fit 15 significant digits (buckets `A`, `D`, `E`, `F`), which every engine runs.

| Scenario | Engines | What it pins |
|---|---|---|
| `decimal-read-exact` | postgres, mysql | list and by-id reads are canonical strings; `100.50` reads `"100.5"`, `0.0000000000` reads `"0"`, 19 digits survive |
| `decimal-read-exact-15` | all | the 15-digit subset |
| `decimal-filter-sort-exact` | postgres, mysql | `eq` / `gt` / `lt` / `in` are exact; `100.500` and `1.005e2` equal `100.5`; a numeric, not textual, sort; three bad operands answer `invalid_filter_value` |
| `decimal-filter-sort-exact-15` | all | the 15-digit subset, plus a bad operand |
| `decimal-write-exact` | postgres, mysql | a 27-digit value, a JSON number, an exponent string and a trailing-zero string are stored canonical; garbage, an 11th fraction digit, a 19th integer digit and a boolean are `400 validation` and persist nothing |
| `decimal-write-exact-15` | all | the 15-digit subset |
| `decimal-report-exact` | postgres, mysql | the `EntryTotals` rows are exactly `seed.json` `reports`; a decimal measure filters exactly; `entries` (a count) is a JSON number |
| `decimal-report-exact-15` | all | buckets A, D, E, F of the report |

## Files

```
decimal/
├── README.md
├── meta.json               # Entry + the EntryTotals report (served at /api/entry_totals)
├── seed.json               # `entries` (eleven rows) and `reports` (what v_entry_totals returns)
├── schema.postgres.sql     # TypeScript-produced: the table and the view
├── schema.sqlite.sql       # the same, for SQLite and D1
├── schema.mysql.sql        # MySQL 8.4: the hand-written table plus the view buildReportViews lowers
└── scenarios/
```

`seed.json` stores amounts as **strings** (`"100.50"`, `"0.0000000000"`), never numbers, so a
port can build its own decimal from the text without a float in between. `reports` is what the
seam lanes serve in place of the view; a TypeScript test holds it equal to what the views return
on Postgres and MySQL. Ids are numbers on the wire.

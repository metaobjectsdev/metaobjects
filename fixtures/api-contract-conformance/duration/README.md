# `api-contract-conformance/duration/` — a duration is an ISO-8601 span on the wire

Cross-port REST contract for `field.duration`, over one writable entity: `Timer` (table `timers`,
served at `/api/timers`) with a nullable, filterable, sortable `timeout`. The corpus config
(`../.metaobjects/config.json`) pins `"wire": { "durations": "iso" }`, so every port writes the
same canonical form. Under the default `native` setting each port writes its own serializer's form
and this corpus does not apply (`docs/features/api-contract.md`, "The wire setting").

## The rule (D1 to D4)

- **D1, emit.** A duration is a JSON string in the canonical form `[-]PT[nH][nM][n[.f]S]`: hours
  are never folded into days (`PT26H`), zero components are left out, zero is `PT0S`, and a
  fraction has no trailing zeros. `null` stays `null`.
- **D2, accept.** A request body carries the accepted form: optional leading weeks (`P1W` is 7 days)
  and days (`P1DT2H` is 26 hours), then hours, minutes and seconds. It is stored as the span and
  answered canonical (`PT5400S` is answered `PT1H30M`).
- **D3, refuse.** Years and months (a calendar span has no fixed length), a clock spelling
  (`01:30:00`), lowercase designators and a JSON number are `400 {"error": "validation"}` and
  persist nothing.
- **D4, order.** A filter operand uses the D2 grammar and compares spans, never text: `gt`, `lte`
  and a sort take in a negative span, `eq PT5400S` matches `PT1H30M`, and `in` matches across
  spellings. A bad operand is `400 {"error": "invalid_filter_value", "field": "timeout"}`. Postgres
  holds an `interval`; SQLite, D1 and MySQL a BIGINT count of microseconds, which orders the same way.

The wire grammar and its vectors are in [`fixtures/duration-wire/`](../../duration-wire/). Neither
scenario carries an `engines:` key, so both run on every engine a port's lane has.

## Scenarios

| Scenario | What it pins |
|---|---|
| `duration-write-read` | POST and GET by id answer the canonical form for an hour-and-minutes span, days, seconds past an hour, a week, a negative span, zero and a fraction; an absent `timeout` reads `null`; PATCH replaces; `P1M`, `01:30:00`, `pt1h` and `5400` are `400 validation` and persist nothing |
| `duration-filter-sort` | five rows written by POST, then `gt` with a descending sort, `lte` with an ascending sort over a negative span, `eq` and `in` across spellings, `isNull` both ways with `limit`, and two bad operands |

## Files

```
duration/
├── README.md
├── meta.json               # Timer (/api/timers)
├── seed.json               # `timers` (empty, so the first POST is id 1)
├── schema.postgres.sql     # TypeScript-produced: `timeout` is INTERVAL
├── schema.sqlite.sql       # the same, for SQLite and D1: `timeout` is INTEGER (microseconds)
├── schema.mysql.sql        # MySQL 8.4: the hand-written table, `timeout` BIGINT (microseconds)
└── scenarios/
```

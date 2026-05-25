# Result normalization contract

Every per-port runner serializes Postgres result rows to canonical JSON before
comparing against the `expect` block in a query scenario. The contract below is
the single source of truth — if a port can't produce this shape, the port is
broken.

## Why a contract

Postgres returns values that each language driver represents differently:

* `BIGINT` is `long` in .NET, `bigint` in Node (only when configured), `int`
  in Python — and JS `Number` loses precision above 2⁵³.
* `NUMERIC` is `decimal` in .NET, `string` in `node-postgres` by default,
  `Decimal` in Python.
* `TIMESTAMPTZ` may arrive as `DateTime` (local), `DateTimeOffset`, `Date`
  (UTC-shifted), or a string depending on the driver.
* `JSONB` may be parsed-on-read or string-on-read; even when parsed, key
  order is unspecified.

If we let each port emit its driver-native representation we'd be chasing
phantom diffs forever. Pinning the wire format makes cross-port comparison a
byte equality check.

## Per-type rules

| SQL type            | JSON shape                                | Examples                              |
|---------------------|-------------------------------------------|---------------------------------------|
| `BIGINT`, `INT8`    | **string**                                | `"1"`, `"9223372036854775807"`        |
| `INTEGER`, `INT4`   | number                                    | `1`, `-42`                            |
| `SMALLINT`, `INT2`  | number                                    | `1`                                   |
| `BOOLEAN`           | bool                                      | `true`, `false`                       |
| `NUMERIC`/`DECIMAL` | **string** (canonical, no trailing zeros) | `"3.14"`, `"100"` (not `"100.00"`)    |
| `REAL`, `DOUBLE`    | number                                    | `1.5`                                 |
| `TEXT`, `VARCHAR`   | string                                    | `"hello"`                             |
| `DATE`              | string `"YYYY-MM-DD"`                     | `"2026-05-25"`                        |
| `TIMESTAMP`         | string `"YYYY-MM-DDTHH:MM:SS[.fff]"`      | `"2026-05-25T10:30:00"` (no Z)        |
| `TIMESTAMPTZ`       | string `"YYYY-MM-DDTHH:MM:SS[.fff]Z"`     | `"2026-05-25T14:30:00Z"` (UTC always) |
| `UUID`              | string (lowercase canonical)              | `"550e8400-e29b-41d4-a716-446655440000"` |
| `JSON`, `JSONB`     | re-serialized with **sorted keys**        | `{"a": 1, "b": 2}` not `{"b": 2, "a": 1}` |
| `BYTEA`             | base64 string                             | `"aGVsbG8="`                          |
| `NULL`              | JSON `null`                               |                                       |

### Rationale highlights

* **`BIGINT` as string**: avoids the JS `Number` precision cliff (2⁵³).
  Postgres `BIGSERIAL` PKs commonly exceed 2³² in long-lived systems.
* **`NUMERIC` as string** with no trailing zeros: `"3.14"` not `"3.140"`; PG
  retains scale and would otherwise yield diffs based on `numeric(p,s)`. Strip
  trailing zeros from the fractional part and the decimal point itself if the
  value is integer-valued.
* **`TIMESTAMP` no `Z`, `TIMESTAMPTZ` always `Z`**: the suffix discriminates
  the two PG types; never elide it for TZ and never add it for plain timestamp.
* **`JSON`/`JSONB` sorted keys**: PG's `JSONB` reorders keys internally
  anyway, so author-side key order is meaningless.

## Row + result shape

* A row is a JSON object keyed by the **metadata field name** (the `name:` on
  the `field.*` node). For fields with no `@column` override the field name
  and the underlying column name are usually the same — but they don't have
  to be; this is the contract. (Migration scenarios that take a raw SQL
  `apply-up-then-query` path see the raw column name returned by Postgres
  instead; author those `expect:` rows against the column shape.)
* A `list` query result is an ordered array of rows. Order is whatever the
  query produced; scenarios SHOULD use `sort:` for determinism.
* A `get` query result is a single row object, or JSON `null` if no row
  matched.
* A `count` query result is a JSON integer.

## Diff reporting

When `expect` doesn't match `actual`, the runner should print:

```
scenario:   queries/filter-with-like.yaml
query:      filter-with-like
expected:   [{"id":"2","title":"Strength"}]
actual:     [{"id":"2","title":"Strength"},{"id":"3","title":"Mobility"}]
diff:       row 1 unexpected
```

…with the smallest meaningful unit highlighted (extra row, missing row,
specific field mismatch, type mismatch).

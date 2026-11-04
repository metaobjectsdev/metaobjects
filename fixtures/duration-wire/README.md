# field.duration wire vectors

The wire rule for `field.duration` (a fixed-length span of time), and the codecs some ports need
to store one. [`vectors.json`](./vectors.json) has two parts.

## `wire`: every port passes every vector

The ISO-8601 text a caller sends and a port answers under `"wire": { "durations": "iso" }`. Clients depend on it, so every port agrees in that mode. Under the default `native` mode each port writes its own standard form (see [the wire setting](../../docs/features/api-contract.md#the-wire-setting)).

- **`parse`**: a duration a caller may send, and the canonical form a port answers for it. The
  canonical form is `[-]PT[<h>H][<m>M][<s>[.<f>]S]`: hours are never folded into days, zero
  components are left out, zero is `PT0S`, trailing zeros of the fraction are dropped, and a
  negative duration has one leading `-`. A day (`D`) is exactly 24 hours and a week (`W`) exactly
  7 days.
- **`precision`**: the fraction may have any number of digits. A port keeps as many as its own
  duration type holds and truncates the rest toward zero, never rounding. `out` is keyed by that
  number of digits, and a port checks the entry for its own: 6 for TypeScript and Python
  (microseconds), 7 for C# (a `TimeSpan` tick is 100 ns), 9 for Java and Kotlin (`java.time.Duration`).
- **`refused`**: input that is not a duration. Years and months are refused because a calendar
  span has no fixed length. So are lowercase designators, fractional hours, minutes or weeks, a
  comma decimal separator, per-component signs, out-of-order components and whitespace.

There is no shared upper bound. Each port is limited only by its own type (a .NET `TimeSpan`, a
`timedelta`) and each database by its own column; a port refuses what it cannot hold rather than
wrapping it, and tests that limit in its own suite.

## `codecs`: a port passes a group only when it has that codec

| Group | What it pins | Passed by |
|---|---|---|
| `postgres` | the text a Postgres `interval` column returns under the default `IntervalStyle` (`postgres`), and its canonical form | a port that reads an interval as text, or checks a native value (Npgsql `TimeSpan`, a JDBC `PGInterval`) against the same rule |
| `postgresRefused` | an interval with a year or month part; reading one is an error, never a guess at the length of a month | the same ports |
| `postgresText` | a canonical duration and its Postgres spelling, `[-]HH:MM:SS[.f]` with unbounded hours and no day part | a port that binds a duration to Postgres as text, and `meta migrate` for a declared `@default`. Postgres refuses a signed ISO-8601 duration (`-PT1M30S` is "invalid input syntax for type interval"), and returns an interval written this way in the same spelling, so a default never drifts |
| `storedMicros` | a duration and the integer count of microseconds a SQLite, D1 or MySQL column stores for it (`BIGINT`), sub-microsecond digits truncated toward zero | a port that stores durations on one of those databases |

An integer column orders and compares as the span does, so sorting, range filters and equality are
right on every database. This is how Django stores a `DurationField` outside Postgres. The 64-bit
column holds about 2.56 billion hours; a port refuses to bind a longer span there. Postgres keeps its
native `interval`, which holds microseconds.

The Postgres text readers assume the server's default `IntervalStyle`, `postgres`. A session set to
`iso_8601`, `sql_standard` or `postgres_verbose` returns another spelling. A reader accepts it only
where it means the same span (an unsigned `iso_8601` value is plain ISO-8601) and refuses the rest,
such as `iso_8601`'s per-component signs (`PT-1M-30S`), rather than misreading it.

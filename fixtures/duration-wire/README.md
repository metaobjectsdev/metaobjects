# field.duration wire vectors

The wire rule for `field.duration` (a fixed-length span of time), shared by every port so they
agree on every input, not only the ones a persistence scenario happens to write.

- **`parse`**: an ISO-8601 duration a caller may send, and the canonical form every port answers
  for it. The canonical form is `[-]PT[<h>H][<m>M][<s>[.<f>]S]`: hours are never folded into days,
  zero components are left out, zero is `PT0S`, there are at most six fractional digits (the
  precision of a Postgres `interval`; more are truncated toward zero, never rounded), and a
  negative duration has one leading `-`. A day (`D`) is exactly 24 hours. There is no shared
  upper bound: each port is limited only by its own type (a .NET `TimeSpan`, a `timedelta`) and
  each database by its own column, and refuses what it cannot hold rather than wrapping it.
- **`refused`**: input that is not a duration. Years, months and weeks are refused because a
  calendar span has no fixed length. So are lowercase designators, fractional hours or minutes,
  a comma decimal separator, per-component signs, out-of-order components and whitespace.
- **`postgres`**: the text a Postgres `interval` column returns under the default
  `IntervalStyle` (`postgres`), and its canonical form. A port reading through a driver that
  hands back a native value (Npgsql `TimeSpan`, a JDBC `PGInterval`) checks the same rule
  against that value.
- **`postgresRefused`**: an interval with a year or month part is not a duration; reading one
  is an error, never a guess at the length of a month.
- **`postgresText`**: a canonical duration and its Postgres interval spelling, `[-]HH:MM:SS[.f]`
  with unbounded hours and no day part. Postgres refuses an ISO-8601 duration with a leading sign
  (`-PT1M30S` is "invalid input syntax for type interval"), so a port that binds a duration to
  Postgres as TEXT uses this spelling, and so does `meta migrate` for a declared `@default`. An
  interval written this way is returned in exactly this spelling, so a default never drifts and a
  value reads back as it was written. A port whose driver binds a native type (Npgsql `TimeSpan`,
  a JDBC `PGInterval`, a Python `timedelta`) does not need it.
- **`storedMicros`**: a canonical duration and the integer count of microseconds a SQLite, D1 or
  MySQL column stores for it (`BIGINT`; Postgres keeps its native `interval`). An integer orders and
  compares as the span does, so sorting, range filters and equality are right on every database.
  This is how Django stores a `DurationField` outside Postgres. The 64-bit column holds about
  2.56 billion hours; a port refuses to bind a longer span there.

# `check-constraint-conformance/` — the CHECKs one model gets, through either delivery path

One metadata input (`input/`) and the CHECK constraints `meta migrate` derives for it: every
validator that can carry one (`validator.numeric`, `validator.length`, `validator.regex`, the
cross-field `comparison` / `requiredWhen` / `presentIff` / `atLeastOne`, with an `@condition`)
and every scalar `field.enum`. Each expected file maps a table to its CHECKs, in order, as a name
and an expression (the text inside `CHECK (…)`, as written, never Postgres's normalized
`pg_get_constraintdef` form).

| File | Dialect | `migrate.checks.skipRedundant` |
|---|---|---|
| `expected.postgres.json` | `postgres` | false |
| `expected.postgres.skip-redundant.json` | `postgres` | true |
| `expected.sqlite.json` | `sqlite` | false |
| `expected.sqlite.skip-redundant.json` | `sqlite` | true (a no-op: SQLite stores past a declared length) |
| `expected.d1.json` | `d1` (the same as SQLite) | false |

The rules the corpus pins (ruling R55, which follows `meta migrate`):

- names `<table>_<column>_chk` (enum), `_numeric_chk`, `_length_chk`, `_regex_chk`, `_cmp_chk`,
  `_reqwhen_chk`, `_presentiff_chk`, `_atleastone_chk`; a declared `@constraintName` replaces the
  name and is kept even where `skipRedundant` would leave the CHECK out;
- `@dbCheck: false` leaves a numeric, length or regex validator's or an enum's CHECK out, under
  `skipRedundant` too (`npi`, `legacyState`, `rank`'s minimum); a sibling validator on the same
  field keeps its own (`rank`'s maximum), and `@dbCheck: true` is the default (`floor`). A
  cross-field validator always keeps its CHECK: `false` on one is a load error;
- comparisons, not `BETWEEN`; columns double-quoted; an int-backed enum lists its integers; a
  duration literal is the interval text on Postgres and microseconds on SQLite;
- no CHECK on an array column, and none on a derived (origin-bearing) field — it has no column —
  nor a cross-field CHECK naming one (`band`, an `origin.computed` reached by the `HighGadgets`
  projection's `@filter`);
- a string-stored enum gets its membership CHECK and its `validator.length` CHECK, under
  `skipRedundant` too (`channel`); no regex CHECK on SQLite; `IS DISTINCT FROM` on Postgres, `IS NOT`
  on SQLite; `num_nonnulls` on Postgres, a sum of presence tests on SQLite.

Run by TypeScript (`migrate-ts/test/check-constraint-conformance.test.ts`, the reference; it
regenerates these files with `META_WRITE_CHECKS=1`) and C#
(`MetaObjects.Codegen.Tests/CheckConstraintConformanceTests.cs`, which also proves the generated
EF context declares them, and `EfModelGapsTests` on live Postgres). The other ports declare no
CHECK in a generated model, so they do not run it.

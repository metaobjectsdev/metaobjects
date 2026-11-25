- **Rust port's data access: the `repository` generator (ADR-0067 layer 3).** It writes a
  `<package>_store` crate per package with a stored entity, on sqlx, for Postgres and SQLite: per
  entity the table mapping and typed `list` (the nine filter operators, sort, paging), `count`,
  `get`, `create`, `update` and `delete`, and per lifecycle the guarded update
  `transition_<field>(id, from, to)`, one conditional `UPDATE` that answers `false` when another
  writer moved the row first (ADR-0066 §6). The shared `meta_store` crate holds the statements and
  the decode of each column into the model's own types. A single-table subtype writes its
  discriminator and reads only its own rows. A Rust runner for the shared persistence corpus runs
  it on a throwaway Postgres: every list, get, count, create, update, delete, roundtrip and
  single-table scenario passes; the many-to-many, projection and report scenarios are on its
  shrink-only ledger, because projections, reports, many-to-many traversal and flattened storage
  are not stored yet.

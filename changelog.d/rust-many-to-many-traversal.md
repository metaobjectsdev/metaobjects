- **Rust port: many-to-many relationships are traversed (FR-018).** A many-to-many relationship
  of a keyed entity gets `<relation>_of` in its store module, the related rows read through the
  junction in one statement (hetero, directed self-join and `@symmetric` self-join, which keeps a
  row relating a record to itself). The junction's keys come from the same derivation the loader's
  pairing rule runs, now a public function of the core crate (`derive_m2m_fields`). The persistence
  runner runs all 56 scenarios on Postgres, `guarded-update` among them (`meta_store::transition`
  takes a transition's `@condition` and ANDs it into the same statement), and its ledger is empty.

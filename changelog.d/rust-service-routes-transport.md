- **Rust port: the service is served over HTTP (`service-routes`, ADR-0067 layer 5, ADR-0065
  Amendment 7).** A new opt-in generator writes a `<package>_http` crate per package and the shared
  `meta_http` crate: `router(service, actor)` returns an axum `Router` over the generated service,
  with the derived CRUD, traversal, transition-command and declared-operation routes, the
  REST-standard list query (filters with `or`/`and` groups, search, `sort=<field>:asc|desc`, a
  default page of 50, `withCount`) and the named 400s. `ActorSource` (or `ActorFn` over the
  headers) is the app's authentication, handed to the service untouched. It runs only when
  `metaobjects.config.json` lists it: `cargo meta init --transport` adds it, a plain `init` and a
  project with no list leave it out, and `gen --list` marks it `[opt-in]`. A credential field (one
  with a password view) is never returned. An entity with a read-only view beside its table is
  written to the table and read back through the view, so its derived fields are in every answer
  (the store's `Table` gains `read`). A field with no `@sortable` is now sortable when it is
  filterable, as in TypeScript, so a generated client's sort allowlist can grow: regenerate.
  The api-contract corpus runs over HTTP in Rust's generated lane (`core`, `write-through`,
  `secret-fields`, `list-query`, `rules` and its settings variants, 77 scenarios; the rest
  ledgered), the list-query corpus runs all 95 cases, and `examples/rust-service/` is a whole
  tasks service built this way, checked by the `rust` lane.

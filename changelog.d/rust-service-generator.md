- **Rust port: the `service` generator (ADR-0067 layer 4, ADR-0066 §6).** It writes a
  `<package>_service` crate per package with a stored entity: `<Pkg>Service`, generic over the
  database pool (Postgres or SQLite) and the actor type, with each derived list (page size 50 unless
  `api.pagination` says otherwise, `withCount` for the total), get, many-to-many traversal, create,
  update and delete, a command per transition that derives one, and a shell per declared command
  and query. Every write runs in one sqlx transaction, or inside a caller's through its `_in` twin,
  and runs ADR-0066's checks in order: the row (404), the permission point (403 `forbidden`), the
  state (409 `invalid_transition`), the hand-written body, the guarded update (409
  `invalid_transition` or `transition_condition_failed`) and the event hook. The generic update
  answers a changed lifecycle field 409 `state_managed`, a create starts in the initial state, and
  `@autoSet` timestamps are stamped by the service (ADR-0045 Amendment 1). What an app writes are
  traits: `<Pkg>Policy`, `<Pkg>Bodies` (a command answers the move to make or none, and
  `BodyError::Business` a declared error), `<Pkg>Hooks` (one `before` and one `after`, told of
  the write by the `<Pkg>Before` and `<Pkg>After` enums) and `<Pkg>Events`, the last two with
  defaults. The shared `meta_service` crate holds the error codes and statuses. A probe runs the
  rules corpus's scenarios through the service on SQLite, with the settings variants checked in
  the generated text; the HTTP transport, and the shared API tests over it, come next. The walks
  the layer generators share moved into a new engine module, `metaobjects_codegen::layers`, so an
  ejected `service` or `repository` calls the same walk the shipped one does.

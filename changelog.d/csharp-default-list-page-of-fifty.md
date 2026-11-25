- **C#: a list with no `limit` answers 50 rows (breaking).** A generated entity, TPH or projection
  list route in a project that sets no `api.pagination` returned every matching row when the
  request carried no `limit`; it now answers the first 50 (`ApiSettings.DefaultPageLimit`), as every
  port does. An explicit `limit` is still served as asked (no maximum without the setting), and a
  project that sets `api.pagination` is unchanged. Without the setting a `limit` or `offset` that is
  not a non-negative integer is now `400 pagination.invalid_value` instead of being ignored, and
  `limit=0` is a page of zero rows. The `dotnet meta verify --codegen` advisory `unbounded-list-pages`
  is retired. Generated-output change — regenerate to pick it up; three-way merge preserves hand
  edits. Check any client that reads a whole list without a `limit`:
  [docs/features/migrations/default-list-page-of-fifty.md](docs/features/migrations/default-list-page-of-fifty.md).

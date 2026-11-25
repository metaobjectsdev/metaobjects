# Changelog: systems pack

This pack's own changelog (ADR-0069). The root `CHANGELOG.md` records core only.

## [0.1.0] - unreleased

- **First version.** `system.internal`, `system.external`; `app.service`, `app.client`,
  `app.job` (replacing the earlier design's `container.*`); `resource.database`, `.cache`,
  `.bucket`, `.keyvalue`, `.queue`, `.volume`. An app's `@needs` and `@calls` are resolved at
  load (`ERR_SYSTEMS_UNRESOLVED_REF`); `@settings` and `@shell` are names only. TypeScript port.

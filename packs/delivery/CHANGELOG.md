# Changelog: delivery pack

This pack's own changelog (ADR-0069). The root `CHANGELOG.md` records core only.

## [0.1.0] - unreleased

- **First version.** `environment.standing`, `.ephemeral`, `.local`; `build.dockerfile`,
  `.command`, `.static` (at most one per app); `runtime.process`; the abstract `deployment.base`
  a platform pack specialises; `value.literal` and `value.ref`. A deployment's `@app` and
  `@environment` and a `value.ref`'s `@from` are resolved at load (`ERR_DELIVERY_UNRESOLVED_REF`);
  `@secrets` and `@setting` are names only. TypeScript port.

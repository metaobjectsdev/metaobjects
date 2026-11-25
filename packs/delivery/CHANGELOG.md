# Changelog: delivery pack

This pack's own changelog (ADR-0069). The root `CHANGELOG.md` records core only.

## [0.1.0] - unreleased

- **First version.** `environment.standing`, `.ephemeral`, `.local`; `build.dockerfile`,
  `.command`, `.static` (at most one per app); `runtime.process`; the abstract `deployment.base`
  a platform pack specialises; `value.literal` and `value.ref`. A deployment's `@app` and
  `@environment` and a `value.ref`'s `@producedBy` are resolved at load (`ERR_DELIVERY_UNRESOLVED_REF`);
  `@secrets` and `@setting` are names only. A deployment holds one value per `@setting`
  (`ERR_DELIVERY_DUPLICATE_SETTING`) and a model one deployment per (`@app`, `@environment`)
  (`ERR_DELIVERY_DUPLICATE_DEPLOYMENT`). TypeScript port.
- `@watchInclude` on every `build.*`, beside `@watchExclude`: the paths whose change starts a
  build, for an app that lives in one directory of a monorepo.
- `@path` on `value.ref`: a path appended to a URL output (`/api`), for a setting that addresses
  one context of another app.

# Changelog — config pack (`metaobjects-config`)

This pack's own changelog (ADR-0069). Its versions are its own; they never move core's
`metamodelVersion` or package versions.

## [0.1.0] — unreleased (preview, unpublished)

First version. TypeScript only.

- `object.settings`: a settings group whose fields are the settings, scalar field subtypes only.
- `@secret`, `@envName` and `@phase` (`runtime` | `build`), optional attributes on every field
  subtype, read on settings.
- `vault.infisical`, admitted at the document root, with `scope.env` children (`@project`,
  `@env`) and an optional `@defaultScope`.
- Generators: `envExampleFile()` (`.env.example`), `keyManifestFile()` (`keys.manifest.json`)
  and `keysAxiTomlFile()` (`.keys-axi.toml`).

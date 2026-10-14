// ADR-0034 Amendment 8 — which modules of the codegen packages are the ENGINE.
//
// `meta eject <generator>` hands over everything that writes output: the reference
// generator, and the template modules it calls, transitively. What it does NOT hand over
// is the engine — the code that decides WHAT there is to emit rather than writing it:
//
//   - the generator base, the runner's contexts and the formatter,
//   - the model walks (which objects are projections, which fields are sortable, which
//     route an entity is served on, which requirements a model holds),
//   - the naming tables and the type-mapping tables (`names.ts`, `naming.ts`,
//     `column-mapper.ts`) — the ruling in Amendment 8 that an adopter keeps importing them,
//   - the projection/report lowering `meta migrate` and `meta verify` also run.
//
// An owned copy imports these from the package, by its public entry. Every other module
// the owned generator reaches is copied into the project, under `codegen/templates/`.
//
// Paths are relative to `server/typescript/packages/`, the spelling the shared manifest
// (`fixtures/generator-registry-conformance/registry.json`, `eject.engineSurface`) uses, and
// the eject contract test holds this list to that file.
//
// A module that is NOT here and is reached from a reference generator is copied. That is the
// failure that is cheap to see (an owned file that should have stayed packaged shows up in
// `meta eject --list`, and the closure test names it); the reverse — a module that writes
// output left packaged — is the gap this list exists to close.

export const ENGINE_MODULES: readonly string[] = [
  "codegen-ts-tanstack/src/data-grid-gate.ts",
  "codegen-ts/src/api-surface.ts",
  "codegen-ts/src/client-directive.ts",
  "codegen-ts/src/column-mapper.ts",
  "codegen-ts/src/constants.ts",
  "codegen-ts/src/dialect-module.ts",
  "codegen-ts/src/docs-paths.ts",
  "codegen-ts/src/docs-run.ts",
  "codegen-ts/src/enum-import.ts",
  "codegen-ts/src/enum-meta.ts",
  "codegen-ts/src/enum-shared.ts",
  "codegen-ts/src/format.ts",
  "codegen-ts/src/generator.ts",
  "codegen-ts/src/generators/agent-schema-input.ts",
  "codegen-ts/src/generators/api-label.ts",
  "codegen-ts/src/import-path.ts",
  "codegen-ts/src/instance-artifacts.ts",
  "codegen-ts/src/metaobjects-config.ts",
  "codegen-ts/src/names.ts",
  "codegen-ts/src/naming.ts",
  "codegen-ts/src/owned-runtime.ts",
  "codegen-ts/src/pk-resolver.ts",
  "codegen-ts/src/projection/extract-view-spec.ts",
  "codegen-ts/src/projection/projection-detector.ts",
  "codegen-ts/src/projection/report-resolve.ts",
  "codegen-ts/src/projection/report-spec.ts",
  "codegen-ts/src/projection/report-sql.ts",
  "codegen-ts/src/projection/time-sql.ts",
  "codegen-ts/src/projection/view-spec.ts",
  "codegen-ts/src/relation-resolver.ts",
  "codegen-ts/src/render-context.ts",
  "codegen-ts/src/render-engine/framework-provider.ts",
  "codegen-ts/src/requirement-walk.ts",
  "codegen-ts/src/routes-expose.ts",
  "codegen-ts/src/source-detect.ts",
  "codegen-ts/src/templates/entity-ui-descriptor.ts",
  "codegen-ts/src/templates/find-inbound.ts",
  "codegen-ts/src/templates/find-templates.ts",
  "codegen-ts/src/tph.ts",
  "codegen-ts/src/view-context.ts",
];

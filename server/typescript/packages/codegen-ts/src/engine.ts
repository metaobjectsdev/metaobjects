// `@metaobjectsdev/codegen-ts/engine` — the ENGINE an owned generator keeps importing
// (ADR-0034 Amendment 8).
//
// `meta eject` copies a reference generator and the template modules it calls into the
// project, and points every import of an engine module here. This entry is that surface and
// nothing else: one `export *` per module in `ENGINE_MODULES` (engine-surface.ts), which a
// test holds to that list, plus the ts-poet a copied template module must build its `Code`
// with (the 0.21.6 split-tree defect: `Code` is recognised by `instanceof`).
//
// It is a subpath and not the package root on purpose. These are the generator base, the
// model walks and the naming and type-mapping tables, several with short generic names
// (`q`, `ref`, `cond`); they are public so an owned copy can call them, and kept out of the
// adopter-facing root so the root stays the API a project calls.

export * from "./api-surface.js";
export * from "./client-directive.js";
export * from "./column-mapper.js";
export * from "./constants.js";
export * from "./dialect-module.js";
export * from "./docs-paths.js";
export * from "./docs-run.js";
export * from "./enum-import.js";
export * from "./enum-meta.js";
export * from "./enum-shared.js";
export * from "./format.js";
export * from "./generator.js";
export * from "./generators/agent-schema-input.js";
export * from "./generators/api-label.js";
export * from "./import-path.js";
export * from "./instance-artifacts.js";
export * from "./metaobjects-config.js";
export * from "./names.js";
export * from "./naming.js";
export * from "./owned-runtime.js";
export * from "./pk-resolver.js";
export * from "./projection/build-projection-views.js";
export * from "./projection/extract-view-spec.js";
export * from "./projection/projection-detector.js";
export * from "./projection/report-resolve.js";
export * from "./projection/report-spec.js";
export * from "./projection/report-sql.js";
export * from "./projection/time-sql.js";
export * from "./projection/view-spec.js";
export * from "./relation-resolver.js";
export * from "./render-context.js";
export * from "./render-engine/framework-provider.js";
export * from "./requirement-walk.js";
export * from "./routes-expose.js";
export * from "./source-detect.js";
export * from "./templates/entity-ui-descriptor.js";
export * from "./templates/find-inbound.js";
export * from "./templates/find-templates.js";
export * from "./tph.js";
export * from "./view-context.js";
export { ENGINE_MODULES } from "./engine-surface.js";
export { code, imp, joinCode, Import } from "ts-poet";
export type { Code } from "ts-poet";

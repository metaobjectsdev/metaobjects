// Public API surface for @metaobjectsdev/codegen-ts-react.
export { formFile, type FormFileOpts } from "./form-file.js";

// FR-040 §4.2(b) — public so an owned generator composes the engine rather than
// forking it. Signature is stable API: (entity, ctx) => string.
export { renderFormFile } from "./templates/form-file.js";

// FR-040 §4.1 — the copyable reference generator(s) this package ships in
// `src/reference/`, and the reader `meta init`/`meta eject` use to read them.
export { resolveReferenceRoot, readReferenceTemplate, REFERENCE_GENERATOR_NAMES } from "./reference-templates.js";

// Public API surface for @metaobjectsdev/codegen-ts-tanstack.
export { tanstackQuery, type TanstackQueryOpts } from "./tanstack-query.js";
export { tanstackGrid, type TanstackGridOpts } from "./tanstack-grid.js";
export { tanstackGridHook, type TanstackGridHookOpts } from "./tanstack-grid-hook.js";

// FR-040 §4.2(b) — public so an owned generator composes the engine rather than
// forking it. Signatures are stable API: (entity, ctx) => string.
export { renderHooksFile } from "./templates/hooks-file.js";
export { renderColumnsFile } from "./templates/columns-file.js";
export { renderGridHookFile } from "./templates/grid-hook-file.js";

/**
 * Browser-safe metamodel constants.
 *
 * Every metamodel string — type names, subtype names, attribute names — lives in a
 * per-concern `*-constants.ts` module. This barrel re-exports them and **nothing else**,
 * so it can be imported from a browser bundle.
 *
 * <h3>Why this exists (#287)</h3>
 * The package root (`@metaobjectsdev/metadata`) exports `MetaDataLoader`, which imports
 * `library/library-sources.ts`, which does `import { fileURLToPath } from "node:url"`.
 * So *any* value import from the root barrel — even a single string constant — drags the
 * Node-only loader into a browser bundle and the build fails:
 *
 *     error: Browser polyfill for module "node:url" doesn't have a matching export
 *            named "fileURLToPath"  … metadata/dist/library/library-sources.js
 *
 * That made **every** client consuming the generated TanStack hooks unbuildable, because
 * each generated `<Entity>.hooks.ts` imports from `@metaobjectsdev/runtime-web`, which
 * imported six `LAYOUT_*` constants from the root. The root barrel already guards one
 * Node-only module (`registry-coverage.ts`, kept out deliberately with a comment saying
 * why) — `library-sources` reaches it through the loader instead.
 *
 * <h3>The rule</h3>
 * Browser-facing packages (`client/web/**`) import metamodel VALUES from
 * `@metaobjectsdev/metadata/constants`, never from the package root. Types may still come
 * from the root — `import type` is erased at build time and cannot drag a runtime
 * dependency with it.
 *
 * Inlining the strings instead would violate the project's constants discipline
 * ("never inline metamodel strings as literals in code"), so the fix is a safe import
 * path rather than duplicated literals.
 *
 * **Do not add anything to this file that is not a pure constant module.** A single
 * transitive `node:*` import here silently re-breaks every browser build; the
 * `browser-safe-constants` test asserts that by bundling this entry for the browser.
 */

export * from "./core/attr/attr-constants.js";
export * from "./core/documentation/doc-constants.js";
export * from "./core/field/field-constants.js";
export * from "./core/identity/identity-constants.js";
export * from "./core/index/index-constants.js";
export * from "./core/object/object-constants.js";
export * from "./core/query/query-constants.js";
export * from "./core/relationship/relationship-constants.js";
export * from "./core/validator/validator-constants.js";
export * from "./persistence/db/db-constants.js";
export * from "./persistence/origin/origin-constants.js";
export * from "./persistence/source/source-constants.js";
export * from "./presentation/layout/layout-constants.js";
export * from "./presentation/view/view-constants.js";
export * from "./template/template-constants.js";

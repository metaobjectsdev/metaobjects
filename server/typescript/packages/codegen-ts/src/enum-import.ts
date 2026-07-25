// FR-019 — import-specifier resolution for shared + provided enums.
//
// A consuming entity file references a shared enum `E` by importing it:
//   • materialized (non-@provided) → from the generated shared enums module
//     (`./enums`, at the entity-module target root, package-layout-aware).
//   • @provided                    → from the per-port-configured module
//     (`ctx.providedEnumModule`). Missing config ⇒ a codegen-time error naming
//     the enum + the config key (ADR-0026: namespace is config, not metadata).

import type { RenderContext } from "./render-context.js";
import { relativeModuleSpecifier } from "./import-path.js";
import { SHARED_ENUMS_BASENAME } from "./templates/enums-file.js";

/**
 * Specifier to import a MATERIALIZED shared enum into an entity file in
 * `entityPkg`. The shared module sits at the entity-module target root; in
 * package layout the entity may be nested, so the `./enums` base is adjusted by
 * package depth.
 */
export function sharedEnumImportSpecifier(
  ctx: RenderContext,
  entityPkg: string | undefined,
): string {
  // relativeModuleSpecifier adjusts `./enums` for the entity's package depth AND
  // applies the extension style (`.js` under nodenext), so pass the bare base.
  return relativeModuleSpecifier(ctx.selfTarget.outputLayout, entityPkg, `./${SHARED_ENUMS_BASENAME}`, ctx.extStyle);
}

/**
 * Specifier to import an externally-PROVIDED enum. Resolved from codegen config
 * (`providedEnumModule`); throws a clear codegen-time error when unset.
 */
export function providedEnumImportSpecifier(ctx: RenderContext, enumName: string): string {
  const mod = ctx.providedEnumModule;
  if (mod === undefined || mod === "") {
    throw new Error(
      `provided enum "${enumName}" is marked @provided but no module is configured ` +
      `to import it from. Set "providedEnumModule" in your codegen config (e.g. ` +
      `providedEnumModule: "@your-app/enums") so the generated code can reference "${enumName}".`,
    );
  }
  return mod;
}

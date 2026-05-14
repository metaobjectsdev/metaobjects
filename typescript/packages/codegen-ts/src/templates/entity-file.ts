// Entity file composer — combines drizzle-schema, inferred-types, and zod-validators
// into one file with the @generated header. ts-poet deduplicates imports.
//
// Dispatch:
//   isProjection(entity)  → renderProjectionDecl (read-only: view declaration + Zod + filter sections)
//   vanilla / write-through entity → Drizzle table path

import { joinCode, type Code } from "ts-poet";
import type { MetaModel } from "@metaobjects/metadata";
import type { RenderContext } from "../render-context.js";
import { renderDrizzleSchema } from "./drizzle-schema.js";
import { renderInferredTypes } from "./inferred-types.js";
import { renderZodValidators } from "./zod-validators.js";
import { renderEntityConstants } from "./entity-constants.js";
import { renderFilterAllowlist, renderSortAllowlist } from "./filter-allowlist.js";
import { renderFilterType } from "./filter-type.js";
import { GENERATED_HEADER } from "../constants.js";
import { isProjection } from "../projection/projection-detector.js";
import { renderProjectionDecl } from "./projection-decl.js";

export function renderEntityFile(entity: MetaModel, ctx: RenderContext): string {
  // --- Projection path (read-only: view-backed entity with no table source) ---
  if (isProjection(entity)) {
    return renderProjectionDecl(entity, ctx.loadedRoot, {
      columnNamingStrategy: ctx.columnNamingStrategy,
      dialect: ctx.dialect,
      apiPrefix: ctx.apiPrefix,
    });
  }

  // --- Vanilla / write-through entity path ---
  const sections: Code[] = [
    renderDrizzleSchema(entity, ctx),
    renderInferredTypes(entity),
    renderZodValidators(entity),
    renderEntityConstants(entity, ctx.apiPrefix),
    renderFilterAllowlist(entity),
    renderSortAllowlist(entity),
    renderFilterType(entity),
  ];

  // Render ts-poet body first (ts-poet hoists imp()-tracked imports to the top),
  // then prepend the @generated header so it lands at line 1 — convention for
  // generated files and what most tooling (overwrite-policy, IDEs) expects.
  const body = joinCode(sections, { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${entity.name} (${entity.fqn()})\n` +
    `// Customize via ${entity.name}.extra.ts in this directory.\n`;
  return header + body;
}

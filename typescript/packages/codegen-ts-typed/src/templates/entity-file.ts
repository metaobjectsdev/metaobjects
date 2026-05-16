// Entity file composer — combines drizzle-schema, inferred-types, and zod-validators
// into one file with the @generated header. ts-poet deduplicates imports.
//
// POC scope: vanilla entities only (projection path dropped).

import { joinCode, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjects/metadata";
import type { RenderContext } from "../render-context.js";
import { renderDrizzleSchema } from "./drizzle-schema.js";
import { renderInferredTypes } from "../../../codegen-ts/src/templates/inferred-types.js";
import { renderZodValidators } from "../../../codegen-ts/src/templates/zod-validators.js";
import { renderEntityConstants } from "../../../codegen-ts/src/templates/entity-constants.js";
import { renderFilterAllowlist, renderSortAllowlist } from "../../../codegen-ts/src/templates/filter-allowlist.js";
import { renderFilterType } from "../../../codegen-ts/src/templates/filter-type.js";
import { GENERATED_HEADER } from "../../../codegen-ts/src/constants.js";

export function renderEntityFile(entity: MetaObject, ctx: RenderContext): string {
  // --- Vanilla entity path (projection path dropped — out of POC scope) ---
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

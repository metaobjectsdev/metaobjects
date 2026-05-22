// Queries file composer — composes all CRUD function renderers (from queries.ts) into
// a complete <Entity>.queries.ts file with @generated header and correct imports.

import { code, joinCode, type Code } from "ts-poet";
import { MetaObject } from "@metaobjectsdev/metadata";
import { type RenderContext } from "../render-context.js";
import { crossEntitySpecifier, relativeModuleSpecifier } from "../import-path.js";
import {
  renderFindByIdFn,
  renderListFn,
  renderCreateFn,
  renderUpdateFn,
  renderDeleteByIdFn,
} from "./queries.js";
import { variableNameFromEntity } from "../naming.js";
import { GENERATED_HEADER } from "../constants.js";

export function renderQueriesFile(obj: MetaObject, ctx: RenderContext): string {
  const entityName = obj.name;
  // Same-entity sibling import (the entity's own file). Passing the entity's
  // package as both from/to resolves to "./Entity" — its file shares this
  // file's package directory.
  const entityFileName = crossEntitySpecifier(
    ctx.outputLayout,
    obj.package,
    obj.package,
    entityName,
    ctx.extStyle,
  );
  const dbImportSpec = relativeModuleSpecifier(ctx.outputLayout, obj.package, ctx.dbImport);
  const varName = variableNameFromEntity(entityName);

  // Literal imports (db + entity types) live in a code block so they sort
  // alongside ts-poet's hoisted imp() imports at the top of the body.
  const literalImports = code`
import { db } from ${JSON.stringify(dbImportSpec)};
import { ${varName}, type ${entityName}, ${entityName}InsertSchema } from ${JSON.stringify(entityFileName)};
`;

  const sections: Code[] = [
    literalImports,
    renderFindByIdFn(obj, ctx),
    renderListFn(obj, ctx),
    renderCreateFn(obj, ctx),
    renderUpdateFn(obj, ctx),
    renderDeleteByIdFn(obj, ctx),
  ];

  // Render ts-poet body first, then prepend the @generated header so it lands
  // at line 1 ahead of any imports.
  const body = joinCode(sections, { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${obj.fqn()})\n` +
    `// Customize via ${entityName}.extra.ts in this directory (additional queries, custom logic).\n`;
  return header + body;
}

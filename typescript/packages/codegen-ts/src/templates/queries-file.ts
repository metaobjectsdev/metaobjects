// Queries file composer — composes all CRUD function renderers (from queries.ts) into
// a complete <Entity>.queries.ts file with @generated header and correct imports.

import { code, joinCode, type Code } from "ts-poet";
import { MetaObject } from "@metaobjects/metadata";
import { type RenderContext, withExt } from "../render-context.js";
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
  const entityFileName = withExt(`./${entityName}`, ctx.extStyle);
  const varName = variableNameFromEntity(entityName);

  // Literal imports (db + entity types) live in a code block so they sort
  // alongside ts-poet's hoisted imp() imports at the top of the body.
  const literalImports = code`
import { db } from ${JSON.stringify(ctx.dbImport)};
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

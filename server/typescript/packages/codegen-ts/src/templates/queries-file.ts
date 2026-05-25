// Queries file composer — composes all CRUD function renderers (from queries.ts) into
// a complete <Entity>.queries.ts file with @generated header and correct imports.

import { code, joinCode, type Code } from "ts-poet";
import { MetaObject } from "@metaobjectsdev/metadata";
import { type RenderContext } from "../render-context.js";
import { entityModuleSpecifier } from "../import-path.js";
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
  // Import the entity's own file. Same target → relative "./Entity"; cross
  // target → importBase-qualified package path.
  const entityFileName = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    obj.package,
    entityName,
    ctx.extStyle,
  );
  const varName = variableNameFromEntity(entityName);

  // The persistence-context `db` is parameter-passed into every generated CRUD
  // helper (ADR-0008). Emit the dialect-correct Drizzle type alias so the
  // signatures `findXxx(db: Db, ...)` typecheck without the consumer importing
  // anything to construct one. Consumers pass any compatible Drizzle instance.
  const dbTypeImport =
    ctx.dialect === "postgres"
      ? `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`
      : `import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";`;
  const dbTypeAlias =
    ctx.dialect === "postgres"
      ? `type Db = NodePgDatabase<Record<string, never>>;`
      : `type Db = BaseSQLiteDatabase<"async", Record<string, never>>;`;

  // Literal imports (Db type + entity types) live in a code block so they sort
  // alongside ts-poet's hoisted imp() imports at the top of the body.
  const literalImports = code`
${dbTypeImport}
${dbTypeAlias}

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

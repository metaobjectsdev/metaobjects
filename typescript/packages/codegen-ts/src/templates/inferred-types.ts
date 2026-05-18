// Inferred types template — emits Drizzle's InferSelectModel / InferInsertModel type aliases.

import { code, imp, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjects/metadata";
import { variableNameFromEntity } from "../naming.js";

export function renderInferredTypes(entity: MetaObject): Code {
  const varName = variableNameFromEntity(entity.name);
  const selectSym = imp("InferSelectModel@drizzle-orm");
  const insertSym = imp("InferInsertModel@drizzle-orm");
  return code`
export type ${entity.name} = ${selectSym}<typeof ${varName}>;
export type New${entity.name} = ${insertSym}<typeof ${varName}>;
`;
}

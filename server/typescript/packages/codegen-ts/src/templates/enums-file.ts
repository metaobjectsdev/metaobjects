// FR-019 — shared enums module.
//
// Emits, ONCE per run, the materialized (non-@provided) shared enum types that
// at least one concrete entity field references via `extends` of a root-level
// abstract `field.enum`. Each enum yields:
//   • `export type <E> = "A" | "B";`   — the cross-port type identity
//   • `export const <E>Enum = z.enum(["A","B"]);` — the shared Zod validator
//
// Consuming entity files import these instead of redeclaring the union inline.
// @provided enums are NEVER materialized here (they live in hand-written code,
// imported from the configured providedEnumModule).

import { code, imp, joinCode, type Code } from "ts-poet";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { GENERATED_HEADER } from "../constants.js";
import { materializedSharedEnums, type SharedEnum } from "../enum-shared.js";
import { enumUnionString } from "./inferred-types.js";

/** Basename (no extension) of the shared-enums module emitted at the entity-module target root. */
export const SHARED_ENUMS_BASENAME = "enums";

/** The exported Zod-constant name for a shared enum (`<E>Enum`). */
export function sharedEnumZodConstName(enumName: string): string {
  return `${enumName}Enum`;
}

/** One enum's two declarations (type alias + shared z.enum const). */
function renderOneSharedEnum(e: SharedEnum): Code {
  const z = imp("z@zod");
  const members = e.values.map((v) => JSON.stringify(v)).join(", ");
  return code`
export type ${e.name} = ${enumUnionString(e.values)};
export const ${sharedEnumZodConstName(e.name)} = ${z}.enum([${members}]);
`;
}

/**
 * The full shared-enums module body, or null when the model has no materialized
 * shared enums (so the generator emits no file at all).
 */
export function renderSharedEnumsFile(root: MetaRoot): string | null {
  const enums = materializedSharedEnums(root);
  if (enums.length === 0) return null;

  const body = joinCode(enums.map(renderOneSharedEnum), { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Shared enum types (FR-019): one declaration per reused package-level enum.\n`;
  return header + body;
}

// `<Entity>.meta.ts` — the entity descriptor, with no database in the module graph.
//
// The generated UI files (hooks, grid hooks, forms) value-import exactly ONE thing
// from the entity module: the `<Entity>` descriptor const. Everything else they take
// is `import type`, which the compiler erases. But `<Entity>.ts` also constructs the
// Drizzle table at module scope, so that single value import dragged the entire ORM
// into every browser bundle — measured at 716 KB for one generated hook, containing
// `SQLiteTable` and the whole driver.
//
// Nothing in the UI path READS the table. The descriptor is plain data — `$table` is
// a string, not a table object — so this was never a semantic dependency on the
// database, only a physical one created by sharing a module. A `/* @__PURE__ */`
// annotation on the table construction does NOT help (measured: still 716 KB), so
// separating the module is the fix.
//
// Deliberately ADDITIVE. `<Entity>.ts` is untouched and still exports the descriptor,
// so every existing import keeps working and this stays a PATCH. The UI generators
// simply take the descriptor from here instead, and each emits this file itself —
// byte-identical between them, which #266 collapses — rather than depending on the
// consumer having wired an extra generator, since the entity generator is
// scaffold-and-own (ADR-0034) and cannot be changed from the package.

import { code, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { GENERATED_HEADER } from "../constants.js";
import { renderEntityConstants } from "./entity-constants.js";

/** File name (no directory) of an entity's DB-free descriptor module. */
export function entityMetaFileName(entityName: string): string {
  return `${entityName}.meta.ts`;
}

/** Module specifier the UI files use to reach it — a same-directory sibling. */
export function entityMetaSpecifier(entityName: string, extStyle: string | undefined): string {
  return `./${entityName}.meta${extStyle === "js" ? ".js" : ""}`;
}

export function renderEntityMetaFile(
  entity: MetaObject,
  /**
   * @deprecated Accepted and IGNORED — see `renderEntityConstants`. The API base URL
   * left the descriptor; the client provider's `baseUrl` supplies it at runtime.
   *
   * §A6 fix round 3. OPTIONAL, and it must stay optional: this function is called
   * from codegen-ts-tanstack's reference/hooks.ts and reference/grid-hook.ts, both
   * copied verbatim into adopter repos (ADR-0034). A required parameter would fail
   * to compile in every ejected copy.
   */
  _apiPrefix = "",
  names?: { readonly name: string; readonly symbol: Code } | undefined,
): string {
  const body = code`
// ${GENERATED_HEADER} — DO NOT EDIT.
// Source metadata: ${entity.name}
//
// Browser-safe: this module contains ONLY the entity descriptor — plain data, no
// Drizzle table and no database import of any kind. The generated UI files import it
// from here so a client bundle never pulls the ORM in. \`${entity.name}.ts\` also
// exports this descriptor, for server-side and pre-existing consumers.

${renderEntityConstants(entity, "", names)}
`;
  return body.toString();
}

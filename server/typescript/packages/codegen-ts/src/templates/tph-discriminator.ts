// FR-017 Tier 1 — TS discriminated-union + type guards + dispatcher emission.
//
// For an entity that carries `@discriminator`, this template emits:
//   1. `export type <Base> = <Sub1> | <Sub2> | ...` — discriminated union of
//      every concrete subtype declaring @discriminatorValue against this base.
//   2. `export function is<Sub>(value: <Base>): value is <Sub>` — one type
//      guard per subtype, checking the discriminator field's value.
//   3. `export function parse<Base>(row: unknown): <Base>` — runtime dispatcher
//      that reads the discriminator off the raw row and parses with the
//      matching subtype's Zod schema.
//
// When the entity does NOT carry @discriminator, returns null. When the entity
// carries @discriminator but has no concrete subtypes yet (refactor-in-progress
// shape — covered by FR-014 fixture `tph-discriminator-string-no-subtypes`),
// returns null too: there are no subtype names to union.

import { code, joinCode, imp, type Code } from "ts-poet";
import {
  type MetaObject,
  type MetaRoot,
  OBJECT_ATTR_DISCRIMINATOR,
  OBJECT_ATTR_DISCRIMINATOR_VALUE,
  OBJECT_SUBTYPE_ENTITY,
} from "@metaobjectsdev/metadata";

interface SubtypeBinding {
  subtype: MetaObject;
  value: string;
}

/** Render the TPH union + guards + dispatcher block, or null when the entity
 *  is not a discriminator-bearing base with at least one concrete subtype. */
export function renderTphDiscriminatorUnion(
  base: MetaObject,
  root: MetaRoot,
): Code | null {
  const discFieldName = base.ownAttr(OBJECT_ATTR_DISCRIMINATOR);
  if (typeof discFieldName !== "string" || discFieldName === "") return null;

  const subtypes = collectConcreteSubtypes(base, root);
  if (subtypes.length === 0) return null;

  const baseName = base.name;

  // 1. Union type alias. Subtype names are imported lazily via ts-poet `imp()`
  //    so they resolve cross-module without manual import wiring.
  const unionMembers: Code[] = subtypes.map((b) => {
    const sub = imp(`t:${b.subtype.name}@./${b.subtype.name}.js`);
    return code`${sub}`;
  });
  const unionType = code`export type ${baseName} = ${joinCode(unionMembers, { on: " | " })};`;

  // 2. Type guards.
  const guards: Code[] = subtypes.map((b) => {
    const sub = imp(`t:${b.subtype.name}@./${b.subtype.name}.js`);
    return code`
/** True when value is a ${b.subtype.name} (discriminated by ${discFieldName} === "${b.value}"). */
export function is${b.subtype.name}(value: ${baseName}): value is ${sub} {
  return value.${discFieldName} === "${b.value}";
}`;
  });

  // 3. Dispatcher. The head-read uses z.object so the discriminator is read
  //    without committing the row to any subtype yet.
  const z = imp("z@zod");
  const enumLiterals = subtypes.map((b) => JSON.stringify(b.value)).join(", ");

  const caseBranches: Code[] = subtypes.map((b) => {
    const schema = imp(`${b.subtype.name}Schema@./${b.subtype.name}.js`);
    return code`    case ${JSON.stringify(b.value)}: return ${schema}.parse(row);`;
  });

  const dispatcher = code`
/**
 * Parse a row from the ${baseName} table, dispatching by the
 * \`${discFieldName}\` discriminator value to the matching subtype's
 * Zod schema. Throws on unknown discriminator values.
 */
export function parse${baseName}(row: unknown): ${baseName} {
  const head = ${z}.object({ ${discFieldName}: ${z}.enum([${enumLiterals}]) }).parse(row);
  switch (head.${discFieldName}) {
${joinCode(caseBranches, { on: "\n" })}
  }
}
`;

  return code`
${unionType}

${joinCode(guards, { on: "\n" })}

${dispatcher}
`;
}

/** Walk every top-level object.entity in the root and return the concrete
 *  subtypes whose @discriminatorValue is bound to this base via extends.
 *  Abstract intermediates are skipped (they don't have polymorphic instances). */
function collectConcreteSubtypes(base: MetaObject, root: MetaRoot): SubtypeBinding[] {
  const bindings: SubtypeBinding[] = [];
  for (const obj of root.objects()) {
    if (obj.subType !== OBJECT_SUBTYPE_ENTITY) continue;
    if (obj.isAbstract === true) continue;
    if (obj === base) continue;

    const value = obj.ownAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE);
    if (typeof value !== "string" || value === "") continue;

    // Walk this entity's extends chain looking for `base`.
    let cursor = obj.superResolved;
    let found = false;
    while (cursor !== undefined) {
      if (cursor === base) {
        found = true;
        break;
      }
      cursor = cursor.superResolved;
    }
    if (!found) continue;

    bindings.push({ subtype: obj, value });
  }
  // Stable order by subtype name so emission is deterministic.
  bindings.sort((a, b) => a.subtype.name.localeCompare(b.subtype.name));
  return bindings;
}

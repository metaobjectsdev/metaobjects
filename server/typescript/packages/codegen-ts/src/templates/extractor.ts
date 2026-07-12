// server/typescript/packages/codegen-ts/src/templates/extractor.ts
//
// The strict `extract` tier — a generated `<Name>.extractor.ts` that sits OVER the existing tolerant
// extractLenient<Name> and turns dirty LLM text into the STRICT typed payload graph (nested objects +
// arrays-of-objects populated) in one call.
//
// Cross-port parity: this mirrors the Java ExtractorCodeGenerator (FOC Task 6). The Java port's
// extract(loader, text) / extractLenient(loader, text) both take the loaded MetaDataLoader and delegate
// to the Phase-B runtime extract (MetaObjectExtractor) so the WHOLE nested graph is assembled; the
// returned flavored object IS the strict type there (the binding provider makes newInstance()
// return it). TS has no flavored object-class — extractLenient returns an all-nullable `<Name>Extracted`
// mirror and the strict payload is a separate `interface`, so the TS port adds the recursive
// mirror→strict mapper (toStrict<Type>) that the Java/Kotlin ports get for free from the runtime.
//
// Why extract takes the MetaRoot: the SELF-CONTAINED extractLenient<Name>(text) leaves nested objects
// null (the historical FR-010 gap). The nested-capable path is extractLenient<Name>WithLoader(root, text),
// which delegates to the runtime extract. So the extract tier — like the Java port — is loader
// (MetaRoot)-driven. extractLenient<Name>WithLoader is re-exposed here under the public name extractLenient<Name>.
//
// NO registry / binding provider / factory; codegen walks the whole type graph statically (the
// same MetaObject walk the extract-schema / payload emitters use).

import {
  type MetaData,
  type MetaField,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_REQUIRED,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_FORMAT,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";
import { fields, isArray } from "./fr010-field-mapping.js";
import { mirrorName } from "./extract-delegate-emitter.js";
import { enumUnionAliasName } from "./inferred-types.js";
import { enumValues } from "../enum-meta.js";

// ADR-0039: resolving — root has no super (children()==ownChildren()); a top-level object/template may itself extend, so resolve rather than work-by-accident.
// ADR-0042: resolveObjectRef gives package-local-before-root-level precedence for a bare ref, FQN-exact otherwise.
function findObject(root: MetaData, name: string, referrerPkg = ""): MetaData | undefined {
  return resolveObjectRef(root, name, referrerPkg).node;
}

// ADR-0039: resolving — root has no super (children()==ownChildren()); a top-level object/template may itself extend, so resolve rather than work-by-accident.
function findTemplate(root: MetaData, name: string): MetaData | undefined {
  return root.children().find((c) => c.type === TYPE_TEMPLATE && c.name === name);
}

/** The @objectRef target VO for a nested-object field, or undefined when unresolvable. */
function refVo(field: MetaData, root: MetaData): MetaData | undefined {
  const ref = field.attr(FIELD_ATTR_OBJECT_REF);
  if (typeof ref !== "string") return undefined;
  // ADR-0042: resolve as authored — a bare ref binds the declaring VO's package,
  // an FQN exactly; NO bare-tail fallback (never bind a same-named VO elsewhere).
  return findObject(root, ref, field.parent?.package ?? field.parent?.fileDefaultPackage ?? "");
}

function isObjectField(field: MetaData): boolean {
  return field.subType === FIELD_SUBTYPE_OBJECT;
}

/**
 * The union-alias type name for a `field.enum` with effective `@values`, or undefined when the
 * field is not a value-constrained enum. Reuses `enumUnionAliasName` — the SAME naming the entity
 * inferred-types emitter types the field as — so the cast target resolves to the exact alias
 * exported from the owning VO's entity module. `ownerName` is the owning value-object's interface name.
 */
function enumAlias(field: MetaData, ownerName: string): string | undefined {
  if (field.subType !== FIELD_SUBTYPE_ENUM) return undefined;
  const values = enumValues(field as MetaField);
  if (values === undefined) return undefined;
  return enumUnionAliasName(ownerName, field as MetaField);
}

/**
 * True iff the field is required IN THE STRICT PAYLOAD TYPE. The strict payload IS the VO's own
 * generated entity-module interface (`renderValueObjectInterface`), which types a required field
 * `f: T` and an optional one `f?: T` (i.e. `T | undefined` — NOT `T | null`). So the mapper's
 * optionality assumption (`m.f!` vs `m.f ?? undefined`) has to agree with THAT interface, and an
 * absent optional maps to `undefined`, never `null`. This predicate matches the interface's
 * required test (boolean `true` only) so the two never skew.
 */
function isFieldRequired(field: MetaData): boolean {
  return field.attr(FIELD_ATTR_REQUIRED) === true;
}

/** The mirror→strict mapper name for a value-object (`toStrict<Name>`). */
function mapperName(vo: MetaData): string {
  return `toStrict${vo.name}`;
}

/**
 * The mapper-body initializer expression for one field, reading mirror member `m.<name>` and
 * mapping it onto the strict payload's exact optionality (required → `m.f!`; optional → `m.f ?? undefined`).
 * The strict payload is the VO's generated entity-module interface, whose optional fields are
 * `f?: T` (= `T | undefined`, never `T | null`), so an absent optional maps to `undefined`.
 * Nested single/array objects recurse into their toStrict<Type> mapper, guarding when optional.
 */
function strictArg(field: MetaData, root: MetaData, ownerName: string): string {
  const name = field.name;
  const required = isFieldRequired(field);

  if (isObjectField(field)) {
    const target = refVo(field, root);
    if (target === undefined) {
      // Unresolved @objectRef — the payload type would be `unknown`; pass through as-is.
      return required ? `m.${name}!` : `m.${name} ?? undefined`;
    }
    const fn = mapperName(target);
    if (isArray(field)) {
      // Required array-of-objects: each element mapped; element nulls dropped at the type level
      // via the non-null assertion (extract never yields null elements for a present array).
      if (required) return `m.${name}!.map((e) => ${fn}(e!))`;
      return `m.${name} ? m.${name}!.map((e) => ${fn}(e!)) : undefined`;
    }
    // Single nested object.
    if (required) return `${fn}(m.${name}!)`;
    return `m.${name} ? ${fn}(m.${name}) : undefined`;
  }

  // Scalar ARRAY (e.g. `field.string` with isArray): the mirror types it `(T | null)[] | null`
  // but the strict payload types it `T[]` (required) / `T[]?` (optional). A bare `m.f!`
  // would leave the element type `T | null`, a `tsc --strict` TS2322 error. Filter out null
  // elements so the element type narrows to non-null (consistent with the lost-element DROP policy
  // already used for required arrays-of-objects above). An absent optional array maps to `undefined`.
  //
  // ENUM arrays: the mirror element is a plain `string`, but the strict payload types it as the
  // closed `<Alias>[]` union. The null-filter alone narrows to `string[]`, not `<Alias>[]` — a
  // `tsc --strict` TS2322 error. So the null-filtered result is CAST to `<Alias>[]`. The cast is
  // sound: the engine validated each present element is a member of the closed set (else the field
  // is lost/MALFORMED and extract throws), so the runtime string IS a valid union member.
  const alias = enumAlias(field, ownerName);
  if (isArray(field)) {
    if (required) {
      const filtered = `(m.${name} ?? []).filter((x): x is NonNullable<typeof x> => x != null)`;
      return alias !== undefined ? `(${filtered}) as ${alias}[]` : filtered;
    }
    const filtered = `m.${name}.filter((x): x is NonNullable<typeof x> => x != null)`;
    const guarded = `m.${name} == null ? undefined : ${filtered}`;
    return alias !== undefined
      ? `m.${name} == null ? undefined : (${filtered}) as ${alias}[]`
      : guarded;
  }

  // Scalar / enum (single): the strict payload's optionality decides the shape.
  // Required → non-null assertion; optional → `?? undefined` (matches the entity-module `f?: T`).
  //
  // ENUM scalar: the mirror member is a plain `string`, but the strict payload types it as the
  // closed `<Alias>` union — assigning `string` into `<Alias>` is a `tsc --strict` TS2322 error.
  // So the value is CAST to `<Alias>`. Sound for the same reason as enum arrays above: the engine
  // already validated membership (or extract throws on a lost required field).
  if (alias !== undefined) {
    return required ? `m.${name}! as ${alias}` : `(m.${name} ?? undefined) as ${alias} | undefined`;
  }
  return required ? `m.${name}!` : `m.${name} ?? undefined`;
}

/**
 * Emit one `toStrict<VO>(m)` mapper per value-object reachable from `vo` (payload + nested,
 * deduped, cycle-safe). Each maps the all-nullable `<VO>Extracted` mirror onto the strict `<VO>`
 * payload interface. The ROOT mapper reads the canonically-named root mirror (`<Template>Extracted`)
 * since the template name may differ from the payload VO name.
 */
function emitMappers(payloadVo: MetaData, root: MetaData, rootMirror: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  emitMapper(payloadVo, root, seen, out, rootMirror);
  return out.join("\n\n");
}

function emitMapper(
  vo: MetaData,
  root: MetaData,
  seen: Set<string>,
  out: string[],
  mirrorOverride?: string,
): void {
  if (seen.has(vo.name)) return;
  seen.add(vo.name);

  const fn = mapperName(vo);
  const strict = vo.name;
  const mir = mirrorOverride ?? mirrorName(vo);
  const assigns = fields(vo).map((f) => `    ${f.name}: ${strictArg(f, root, vo.name)},`);
  out.push(
    [
      `/** Map the all-nullable \`${mir}\` mirror onto the strict \`${strict}\` payload. Generated. */`,
      `function ${fn}(m: ${mir}): ${strict} {`,
      `  return {`,
      ...assigns,
      `  };`,
      `}`,
    ].join("\n"),
  );

  for (const f of fields(vo)) {
    if (isObjectField(f)) {
      const target = refVo(f, root);
      if (target !== undefined) emitMapper(target, root, seen, out);
    }
  }
}

/**
 * One payload-type import group: the strict types (VO interface + its own enum
 * union-aliases) imported from a single VO entity module.
 */
interface PayloadImportGroup {
  /** The VO whose entity module exports these types (`./<module>.js`). */
  module: string;
  /** The strict type names exported by that module, in discovery order. */
  types: string[];
}

/**
 * Group the strict payload types reachable from `vo` BY THE ENTITY MODULE THAT EXPORTS THEM.
 *
 * Each value-object gets its own generated entity module (`entityFile()` emits `<VO>.ts` exporting
 * `export interface <VO>`), and `renderEnumTypeAliases` hoists every `field.enum` union-alias INTO
 * the OWNING VO's module (`export type <Owner><Field> = ...` co-located with the interface). So a
 * VO's interface AND the aliases for its own enum fields are imported from `./<VO>.js` — NOT from a
 * single `payloads.ts` (which no generator emits). Deduped, in discovery order, one group per VO.
 */
function reachablePayloadGroups(vo: MetaData, root: MetaData): PayloadImportGroup[] {
  const groups: PayloadImportGroup[] = [];
  const seenVo = new Set<string>();
  const seenAlias = new Set<string>();
  const visit = (cur: MetaData) => {
    if (seenVo.has(cur.name)) return;
    seenVo.add(cur.name);
    // The VO interface + its OWN enum aliases share the VO's entity module.
    const types: string[] = [cur.name];
    for (const f of fields(cur)) {
      const alias = enumAlias(f, cur.name);
      if (alias !== undefined && !seenAlias.has(alias)) {
        seenAlias.add(alias);
        types.push(alias);
      }
    }
    groups.push({ module: cur.name, types });
    // Recurse into nested object refs (their interfaces live in their own modules).
    for (const f of fields(cur)) {
      if (isObjectField(f)) {
        const target = refVo(f, root);
        if (target !== undefined) visit(target);
      }
    }
  };
  visit(vo);
  return groups;
}

/** Collect the mirror-interface names reachable from `vo` (root mirror + nested VO mirrors). */
function reachableMirrorTypes(vo: MetaData, root: MetaData, rootMirror: string): string[] {
  const out: string[] = [rootMirror];
  const seen = new Set<string>([vo.name]);
  const visit = (cur: MetaData) => {
    for (const f of fields(cur)) {
      if (isObjectField(f)) {
        const target = refVo(f, root);
        if (target !== undefined && !seen.has(target.name)) {
          seen.add(target.name);
          out.push(mirrorName(target));
          visit(target);
        }
      }
    }
  };
  visit(vo);
  return out;
}

/**
 * Render the full `<TemplateName>.extractor.ts` for one `template.output` node.
 * Throws if the template isn't found / isn't a template.output / its @payloadRef doesn't resolve,
 * or if the target format is not json/xml (the extract tier requires the extract<Name> API, which
 * only the json/xml output-parsers emit).
 */
export function renderExtractor(root: MetaData, templateName: string): string {
  const tmpl = findTemplate(root, templateName);
  if (!tmpl) {
    throw new Error(`template "${templateName}" not found in metadata root`);
  }
  if (tmpl.subType !== TEMPLATE_SUBTYPE_OUTPUT) {
    throw new Error(`template "${templateName}" is not a template.output (got subtype "${tmpl.subType}")`);
  }
  // ADR-0039: resolving — a template may inherit its @* refs/format/kind via extends.
  const payloadRef = tmpl.attr(TEMPLATE_ATTR_PAYLOAD_REF);
  if (typeof payloadRef !== "string") {
    throw new Error(`template "${templateName}" missing @payloadRef`);
  }
  // ADR-0042: a bare @payloadRef resolves in the template's package.
  const vo = findObject(root, payloadRef, tmpl.package ?? tmpl.fileDefaultPackage ?? "");
  if (!vo) {
    throw new Error(`template "${templateName}" @payloadRef "${payloadRef}" not found in metadata root`);
  }
  // ADR-0039: resolving — a template may inherit its @* refs/format/kind via extends.
  const format = ((tmpl.attr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text").toLowerCase();
  if (format !== "json" && format !== "xml") {
    throw new Error(
      `template "${templateName}" @format "${format}" has no extract API to extract over (json/xml only)`,
    );
  }

  const strictType = vo.name; // the payload VO's interface name (payload-codegen emits the bare VO name)
  const rootMirror = `${templateName}Extracted`;
  const extractLenientWithName = `extractLenient${templateName}WithLoader`; // the nested-capable lenient extract (output-parser)
  const extractLenientPublic = `extractLenient${templateName}`; // re-exposed never-throws lenient tier name
  const extractName = `extract${templateName}`;
  const rootMapper = mapperName(vo);

  const payloadGroups = reachablePayloadGroups(vo, root);
  const mirrorTypes = reachableMirrorTypes(vo, root, rootMirror);
  const mappers = emitMappers(vo, root, rootMirror);

  // One type-only import per VO entity module (the VO interface + its own enum
  // union-aliases co-located there). NOT a single non-existent `./payloads.js`.
  const payloadImports = payloadGroups
    .map((g) => `import type { ${g.types.join(", ")} } from "./${g.module}.js";`)
    .join("\n");

  const lostMsg =
    `${extractName}: lost required field(s): `;

  return (
    `// GENERATED — extractor for "${templateName}".\n` +
    `//\n` +
    `// Turns dirty LLM text into a fully-typed \`${strictType}\` graph (nested objects +\n` +
    `// arrays-of-objects populated) in one call, by delegating to the nested-capable extract and\n` +
    `// mapping the all-nullable mirror onto the strict payload. No registry / binding / factory.\n` +
    `\n` +
    `import {\n  ${extractLenientWithName},\n  type ${mirrorTypes.join(",\n  type ")},\n} from "./${templateName}.output.js";\n` +
    `${payloadImports}\n` +
    `import type { MetaRoot } from "@metaobjectsdev/metadata";\n` +
    `import type { ExtractionResult } from "@metaobjectsdev/render";\n` +
    `\n` +
    `/**\n` +
    ` * Extract a fully-typed \`${strictType}\` from dirty \`text\` using the loaded \`root\` (which must\n` +
    ` * declare the "${strictType}" payload value-object). Runs the tolerant extract, then maps the\n` +
    ` * extracted mirror onto the strict payload.\n` +
    ` *\n` +
    ` * @throws Error iff a \`@required\` field was lost (the strict opt-in gate).\n` +
    ` */\n` +
    `export function ${extractName}(root: MetaRoot, text: string): ${strictType} {\n` +
    `  const r = ${extractLenientWithName}(root, text);\n` +
    `  if (r.report.hasLostRequired()) {\n` +
    `    throw new Error(${JSON.stringify(lostMsg)} + r.report.lostRequired().join(", "));\n` +
    `  }\n` +
    `  return ${rootMapper}(r.data!);\n` +
    `}\n` +
    `\n` +
    `/**\n` +
    ` * Extract a \`${strictType}\` from dirty \`text\` using the loaded \`root\`, never throwing.\n` +
    ` * Re-exposes the nested-capable extract; inspect \`report\` for lost/defaulted fields.\n` +
    ` */\n` +
    `export function ${extractLenientPublic}(root: MetaRoot, text: string): ExtractionResult<${rootMirror}> {\n` +
    `  return ${extractLenientWithName}(root, text);\n` +
    `}\n` +
    `\n` +
    `${mappers}\n`
  );
}

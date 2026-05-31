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
  TYPE_OBJECT,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_REQUIRED,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_FORMAT,
  PACKAGE_SEPARATOR,
} from "@metaobjectsdev/metadata";
import { fields, isArray } from "./fr010-field-mapping.js";
import { mirrorName } from "./extract-delegate-emitter.js";
import { enumUnionAliasName } from "./inferred-types.js";
import { enumValues } from "../enum-meta.js";

function findObject(root: MetaData, name: string): MetaData | undefined {
  return root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === name);
}

function findTemplate(root: MetaData, name: string): MetaData | undefined {
  return root.ownChildren().find((c) => c.type === TYPE_TEMPLATE && c.name === name);
}

/** The @objectRef target VO for a nested-object field, or undefined when unresolvable. */
function refVo(field: MetaData, root: MetaData): MetaData | undefined {
  const ref = field.ownAttr(FIELD_ATTR_OBJECT_REF);
  if (typeof ref !== "string") return undefined;
  const direct = findObject(root, ref);
  if (direct !== undefined) return direct;
  const sep = ref.lastIndexOf(PACKAGE_SEPARATOR);
  if (sep >= 0) return findObject(root, ref.slice(sep + PACKAGE_SEPARATOR.length));
  return undefined;
}

function isObjectField(field: MetaData): boolean {
  return field.subType === FIELD_SUBTYPE_OBJECT;
}

/**
 * The union-alias type name for a `field.enum` with effective `@values`, or undefined when the
 * field is not a value-constrained enum. Reuses `enumUnionAliasName` — the SAME naming the payload
 * emitter (`payload-codegen.ts`) types the field as — so the cast target resolves to the exact
 * alias exported from `payloads.ts`. `ownerName` is the owning value-object's interface name.
 */
function enumAlias(field: MetaData, ownerName: string): string | undefined {
  if (field.subType !== FIELD_SUBTYPE_ENUM) return undefined;
  const values = enumValues(field as MetaField);
  if (values === undefined) return undefined;
  return enumUnionAliasName(ownerName, field as MetaField);
}

/**
 * True iff the field is required IN THE STRICT PAYLOAD TYPE. This MUST match
 * payload-codegen.ts's `isFieldRequired` predicate EXACTLY (boolean `true` only) — the payload
 * interface decides `T` vs `T | null` by that predicate, and the mapper's optionality assumption
 * (`m.f!` vs `m.f ?? null`) has to agree with the type it is constructing. A `@required:"true"`
 * string field is therefore `T | null` in the payload AND optional here (no skew).
 */
function isFieldRequired(field: MetaData): boolean {
  return field.ownAttr(FIELD_ATTR_REQUIRED) === true;
}

/** The mirror→strict mapper name for a value-object (`toStrict<Name>`). */
function mapperName(vo: MetaData): string {
  return `toStrict${vo.name}`;
}

/**
 * The mapper-body initializer expression for one field, reading mirror member `m.<name>` and
 * mapping it onto the strict payload's exact optionality (required → `m.f!`; optional → `m.f ?? null`).
 * Nested single/array objects recurse into their toStrict<Type> mapper, guarding null when optional.
 */
function strictArg(field: MetaData, root: MetaData, ownerName: string): string {
  const name = field.name;
  const required = isFieldRequired(field);

  if (isObjectField(field)) {
    const target = refVo(field, root);
    if (target === undefined) {
      // Unresolved @objectRef — the payload type would be `unknown`; pass through as-is.
      return required ? `m.${name}!` : `m.${name} ?? null`;
    }
    const fn = mapperName(target);
    if (isArray(field)) {
      // Required array-of-objects: each element mapped; element nulls dropped at the type level
      // via the non-null assertion (extract never yields null elements for a present array).
      if (required) return `m.${name}!.map((e) => ${fn}(e!))`;
      return `m.${name} ? m.${name}!.map((e) => ${fn}(e!)) : null`;
    }
    // Single nested object.
    if (required) return `${fn}(m.${name}!)`;
    return `m.${name} ? ${fn}(m.${name}) : null`;
  }

  // Scalar ARRAY (e.g. `field.string` with isArray): the mirror types it `(T | null)[] | null`
  // but the strict payload types it `T[]` (required) / `T[] | null` (optional). A bare `m.f!`
  // would leave the element type `T | null`, a `tsc --strict` TS2322 error. Filter out null
  // elements so the element type narrows to non-null (consistent with the lost-element DROP policy
  // already used for required arrays-of-objects above).
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
    const guarded = `m.${name} == null ? null : ${filtered}`;
    return alias !== undefined
      ? `m.${name} == null ? null : (${filtered}) as ${alias}[]`
      : guarded;
  }

  // Scalar / enum (single): the strict payload's optionality decides the shape.
  // Required → non-null assertion; optional → `?? null` (matches the payload's `f?: T | null`).
  //
  // ENUM scalar: the mirror member is a plain `string`, but the strict payload types it as the
  // closed `<Alias>` union — assigning `string` into `<Alias>` is a `tsc --strict` TS2322 error.
  // So the value is CAST to `<Alias>`. Sound for the same reason as enum arrays above: the engine
  // already validated membership (or extract throws on a lost required field).
  if (alias !== undefined) {
    return required ? `m.${name}! as ${alias}` : `(m.${name} ?? null) as ${alias} | null`;
  }
  return required ? `m.${name}!` : `m.${name} ?? null`;
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
 * Collect the strict payload-interface names reachable from `vo` (for the type-only import),
 * PLUS every enum union-alias reachable from those VOs. Both are exported from `payloads.ts`
 * (the alias is hoisted above the interface there), so the extractor's `as <Alias>` casts need
 * the alias names imported alongside the interface names. Deduped, in discovery order.
 */
function reachablePayloadTypes(vo: MetaData, root: MetaData): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (cur: MetaData) => {
    if (seen.has(cur.name)) return;
    seen.add(cur.name);
    order.push(cur.name);
    for (const f of fields(cur)) {
      const alias = enumAlias(f, cur.name);
      if (alias !== undefined && !seen.has(alias)) {
        seen.add(alias);
        order.push(alias);
      }
      if (isObjectField(f)) {
        const target = refVo(f, root);
        if (target !== undefined) visit(target);
      }
    }
  };
  visit(vo);
  return order;
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
  const payloadRef = tmpl.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
  if (typeof payloadRef !== "string") {
    throw new Error(`template "${templateName}" missing @payloadRef`);
  }
  const vo = findObject(root, payloadRef);
  if (!vo) {
    throw new Error(`template "${templateName}" @payloadRef "${payloadRef}" not found in metadata root`);
  }
  const format = ((tmpl.ownAttr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text").toLowerCase();
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

  const payloadTypes = reachablePayloadTypes(vo, root);
  const mirrorTypes = reachableMirrorTypes(vo, root, rootMirror);
  const mappers = emitMappers(vo, root, rootMirror);

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
    `import type { ${payloadTypes.join(", ")} } from "./payloads.js";\n` +
    `import type { MetaRoot } from "@metaobjectsdev/metadata";\n` +
    `import type { ExtractionResult } from "@metaobjectsdev/render";\n` +
    `\n` +
    `/**\n` +
    ` * Extract a fully-typed \`${strictType}\` from dirty \`text\` using the loaded \`root\` (which must\n` +
    ` * declare the "${payloadRef}" payload value-object). Runs the tolerant extract, then maps the\n` +
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

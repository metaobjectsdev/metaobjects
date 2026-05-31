// server/typescript/packages/codegen-ts/src/templates/extractor.ts
//
// The `extract` tier — a generated `<Name>.extractor.ts` that sits OVER the existing tolerant
// recover<Name> and turns dirty LLM text into the STRICT typed payload graph (nested objects +
// arrays-of-objects populated) in one call.
//
// Cross-port parity: this mirrors the Java ExtractorCodeGenerator (FOC Task 6). The Java port's
// extract(loader, text) / recover(loader, text) both take the loaded MetaDataLoader and delegate
// to the Phase-B runtime recover (MetaObjectRecover) so the WHOLE nested graph is assembled; the
// returned flavored object IS the strict type there (the binding provider makes newInstance()
// return it). TS has no flavored object-class — recover returns an all-nullable `<Name>Recovered`
// mirror and the strict payload is a separate `interface`, so the TS port adds the recursive
// mirror→strict mapper (toStrict<Type>) that the Java/Kotlin ports get for free from the runtime.
//
// Why extract takes the MetaRoot: the SELF-CONTAINED recover<Name>(text) leaves nested objects
// null (the historical FR-010 gap). The nested-capable path is recover<Name>WithLoader(root, text),
// which delegates to the runtime recover. So the extract tier — like the Java port — is loader
// (MetaRoot)-driven. recover<Name>WithLoader is re-exposed here under the public name recover<Name>.
//
// NO registry / binding provider / factory; codegen walks the whole type graph statically (the
// same MetaObject walk the recover-schema / payload emitters use).

import {
  type MetaData,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_REQUIRED,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_FORMAT,
  PACKAGE_SEPARATOR,
} from "@metaobjectsdev/metadata";
import { fields, isArray, jsonStringLiteral } from "./fr010-field-mapping.js";
import { mirrorName } from "./recover-delegate-emitter.js";

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

/** True iff the field's @required is explicitly set (mirrors payload-codegen.isFieldRequired). */
function isFieldRequired(field: MetaData): boolean {
  const v = field.ownAttr(FIELD_ATTR_REQUIRED);
  if (v === true) return true;
  return typeof v === "string" && v.toLowerCase() === "true";
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
function strictArg(field: MetaData, root: MetaData): string {
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
      // via the non-null assertion (recover never yields null elements for a present array).
      if (required) return `m.${name}!.map((e) => ${fn}(e!))`;
      return `m.${name} ? m.${name}!.map((e) => ${fn}(e!)) : null`;
    }
    // Single nested object.
    if (required) return `${fn}(m.${name}!)`;
    return `m.${name} ? ${fn}(m.${name}) : null`;
  }

  // Scalar / enum / scalar-array: the strict payload's optionality decides the shape.
  // Required → non-null assertion; optional → `?? null` (matches the payload's `f?: T | null`).
  return required ? `m.${name}!` : `m.${name} ?? null`;
}

/**
 * Emit one `toStrict<VO>(m)` mapper per value-object reachable from `vo` (payload + nested,
 * deduped, cycle-safe). Each maps the all-nullable `<VO>Recovered` mirror onto the strict `<VO>`
 * payload interface. The ROOT mapper reads the canonically-named root mirror (`<Template>Recovered`)
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
  const assigns = fields(vo).map((f) => `    ${f.name}: ${strictArg(f, root)},`);
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

/** Collect the strict payload-interface names reachable from `vo` (for the type-only import). */
function reachablePayloadTypes(vo: MetaData, root: MetaData): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (cur: MetaData) => {
    if (seen.has(cur.name)) return;
    seen.add(cur.name);
    order.push(cur.name);
    for (const f of fields(cur)) {
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
 * or if the target format is not json/xml (the extract tier requires the recover<Name> API, which
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
      `template "${templateName}" @format "${format}" has no recover API to extract over (json/xml only)`,
    );
  }

  const strictType = vo.name; // the payload VO's interface name (payload-codegen emits the bare VO name)
  const rootMirror = `${templateName}Recovered`;
  const recoverWithName = `recover${templateName}WithLoader`; // the nested-capable recover (output-parser)
  const recoverPublic = `recover${templateName}`; // re-exposed extract-tier name
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
    `// arrays-of-objects populated) in one call, by delegating to the nested-capable recover and\n` +
    `// mapping the all-nullable mirror onto the strict payload. No registry / binding / factory.\n` +
    `\n` +
    `import {\n  ${recoverWithName},\n  type ${mirrorTypes.join(",\n  type ")},\n} from "./${templateName}.output.js";\n` +
    `import type { ${payloadTypes.join(", ")} } from "./payloads.js";\n` +
    `import type { MetaRoot } from "@metaobjectsdev/metadata";\n` +
    `import type { RecoveryResult } from "@metaobjectsdev/render";\n` +
    `\n` +
    `/**\n` +
    ` * Extract a fully-typed \`${strictType}\` from dirty \`text\` using the loaded \`root\` (which must\n` +
    ` * declare the "${payloadRef}" payload value-object). Runs the tolerant recover, then maps the\n` +
    ` * recovered mirror onto the strict payload.\n` +
    ` *\n` +
    ` * @throws Error iff a \`@required\` field was lost (the strict opt-in gate).\n` +
    ` */\n` +
    `export function ${extractName}(root: MetaRoot, text: string): ${strictType} {\n` +
    `  const r = ${recoverWithName}(root, text);\n` +
    `  if (r.report.hasLostRequired()) {\n` +
    `    throw new Error(${JSON.stringify(lostMsg)} + r.report.lostRequired().join(", "));\n` +
    `  }\n` +
    `  return ${rootMapper}(r.data!);\n` +
    `}\n` +
    `\n` +
    `/**\n` +
    ` * Recover a \`${strictType}\` from dirty \`text\` using the loaded \`root\`, never throwing.\n` +
    ` * Re-exposes the nested-capable recover; inspect \`report\` for lost/defaulted fields.\n` +
    ` */\n` +
    `export function ${recoverPublic}(root: MetaRoot, text: string): RecoveryResult<${rootMirror}> {\n` +
    `  return ${recoverWithName}(root, text);\n` +
    `}\n` +
    `\n` +
    `${mappers}\n`
  );
}

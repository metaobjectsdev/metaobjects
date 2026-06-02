// server/typescript/packages/codegen-ts/src/templates/output-parser.ts
//
// Per-template renderer for template.output codegen. Walks the @payloadRef's
// value-object into a Zod schema and emits a dual-API parser (parse + safeParse)
// alongside the schema. The emitted file is self-contained: it derives a
// local data type via `z.infer<typeof Schema>` and exports it as
// `<TemplateName>Data`. Consumers wiring `promptRender()` get a structurally
// identical payload-VO interface in `prompts.ts`; either type can be used
// interchangeably with parse results.

import {
  type MetaData,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_FORMAT,
} from "@metaobjectsdev/metadata";
import {
  schemaLiteral,
  mirrorInitializer,
} from "./extract-schema-emitter.js";
import { extractMapHelpersUsed } from "./fr010-field-mapping.js";
import {
  nestedMirrorInterfaces,
  nestedMappers,
  rootMapperName,
  delegateHelpers,
  usedHelpers,
  hasNested,
} from "./extract-delegate-emitter.js";

const SCALAR_ZOD: Record<string, string> = {
  string: "z.string()",
  class: "z.string()",
  int: "z.number().int()",
  short: "z.number().int()",
  byte: "z.number().int()",
  long: "z.number().int()",
  double: "z.number()",
  float: "z.number()",
  boolean: "z.boolean()",
};

function findObject(root: MetaData, name: string): MetaData | undefined {
  return root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === name);
}

function findTemplate(root: MetaData, name: string): MetaData | undefined {
  return root.ownChildren().find((c) => c.type === TYPE_TEMPLATE && c.name === name);
}

/** Render the Zod expression for a single field; recurses on @objectRef. */
function fieldZod(field: MetaData, root: MetaData, seen: ReadonlySet<string>, depth: number): string {
  // isArray is a native (reserved) property on MetaData, not an attr.
  const isArray = field.isArray === true;
  let base: string;
  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    const refName = field.ownAttr(FIELD_ATTR_OBJECT_REF);
    if (typeof refName !== "string") {
      base = "z.unknown()";
    } else if (seen.has(refName)) {
      // Cycle guard — emit unknown for self-references (rare; lazy schemas not in scope for v1).
      base = "z.unknown()";
    } else {
      const inner = findObject(root, refName);
      base = inner ? renderObjectSchema(inner, root, new Set(seen).add(refName), depth + 1) : "z.unknown()";
    }
  } else {
    base = SCALAR_ZOD[field.subType] ?? "z.unknown()";
  }
  return isArray ? `z.array(${base})` : base;
}

/** Render a `z.object({ ... })` for an object.value node.
 *  At depth 0 the schema starts at column 0 (consumer's `const Foo = z.object({`),
 *  so fields sit at 2 spaces and the closing `})` at 0 spaces — matching the
 *  surrounding `const NameSchema = ...` statement's indent. Nested schemas
 *  step in two spaces per depth level. */
function renderObjectSchema(vo: MetaData, root: MetaData, seen: ReadonlySet<string>, depth: number): string {
  const fields = vo.children().filter((c) => c.type === TYPE_FIELD);
  const fieldIndent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  const lines = fields.map((f) => `${fieldIndent}${f.name}: ${fieldZod(f, root, seen, depth)},`);
  return `z.object({\n${lines.join("\n")}\n${closeIndent}})`;
}

/**
 * Render the full output-parser file for one `template.output` node.
 * Throws if the template isn't found, isn't a template.output, or its
 * @payloadRef doesn't resolve to an object.value.
 */
export function renderOutputParser(root: MetaData, templateName: string): string {
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

  const schema = renderObjectSchema(vo, root, new Set([payloadRef]), 0);
  const schemaName = `${templateName}Schema`;
  const dataName = `${templateName}Data`;
  const errorName = `${templateName}ValidationError`;
  const parseName = `parse${templateName}`;
  const safeParseName = `safeParse${templateName}`;

  // FR-010: emit the tolerant extract() API alongside the strict Zod parser when the
  // template targets json/xml. The @payloadRef already resolved to a value-object above,
  // so a ExtractSchema can always be baked. text-format outputs get no extract.
  const format = (tmpl.ownAttr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text";
  const lc = format.toLowerCase();
  const emitExtractLenient = lc === "json" || lc === "xml";

  const strictBody = `const ${schemaName} = ${schema};

export type ${dataName} = z.infer<typeof ${schemaName}>;
export type ${errorName} = z.ZodError;

/**
 * Parse an LLM response into a typed ${dataName}.
 * @throws ZodError on validation failure.
 */
export function ${parseName}(text: string): ${dataName} {
  return ${schemaName}.parse(JSON.parse(text));
}

/**
 * Parse an LLM response with explicit error handling (Result-style).
 * Does not throw on validation failure.
 */
export function ${safeParseName}(
  text: string,
): { success: true; data: ${dataName} } | { success: false; error: ${errorName} } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      success: false,
      error: new z.ZodError([{ code: "custom", path: [], message: \`invalid JSON: \${(err as Error).message}\` }]),
    };
  }
  const result = ${schemaName}.safeParse(parsed);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}
`;

  if (!emitExtractLenient) {
    return `import { z } from "zod";\n\n${strictBody}`;
  }

  // ---- FR-010 tolerant extract block (json/xml only) ----
  const extractedName = `${templateName}Extracted`;
  const extractLenientFnName = `extractLenient${templateName}`;
  const tryExtractLenientName = `tryExtractLenient${templateName}`;
  const extractLenientWithName = `extractLenient${templateName}WithLoader`;
  const schemaConstName = `${templateName}ExtractSchema`;
  const payloadFqnConst = `${templateName.toUpperCase()}_PAYLOAD_NAME`;
  const formatEnum = format.toLowerCase() === "xml" ? "Format.XML" : "Format.JSON";
  const schemaLit = schemaLiteral(vo, format, payloadRef);
  const initializer = mirrorInitializer(vo);
  const mapHelpers = extractMapHelpersUsed(vo);

  // The nullable mirror is shared by BOTH extract paths. Use the nested-aware emitter so the
  // payload mirror's nested-object / array-of-object components are typed (not `unknown`), and
  // so a mirror interface is emitted for every reachable nested value-object. The payload mirror
  // keeps the canonical `<Template>Extracted` name (instead of `<PayloadVO>Extracted`) so the
  // existing self-contained extract<Name>() initializer continues to satisfy it.
  const mirrorDecls = nestedMirrorInterfaces(vo, root, extractedName);
  const payloadHasNested = hasNested(vo, root);

  // Render-package imports the extract block needs. Only pull in the names the emitted
  // source actually references, so the file has no unused imports (tsc noUnusedLocals-safe).
  const renderImports = ["extract", "extractSchema", "Format"];
  if (schemaLit.includes("scalar(")) renderImports.push("scalar");
  if (schemaLit.includes("textContentField(")) renderImports.push("textContentField");
  if (schemaLit.includes("enumField(")) renderImports.push("enumField");
  if (schemaLit.includes("FieldKind.")) renderImports.push("FieldKind");
  renderImports.push("type ExtractSchema", "type ExtractOptions", "type ExtractionResult");
  renderImports.push(...mapHelpers);

  const selfContained = `/** Baked extract descriptor for the ${templateName} output. */
const ${schemaConstName}: ExtractSchema = ${schemaLit};

${mirrorDecls}

/**
 * Self-contained tolerant best-effort extraction of a dirty LLM response; never throws.
 * Returns a nullable mirror (\`${extractedName}\`) with fields null where lost/malformed,
 * plus the per-field extraction report. Does NOT populate nested-object / array-of-object
 * components (those stay null — the historical FR-010 gap). For full nested extraction, use
 * \`${extractLenientWithName}(root, text)\`, which delegates to the runtime extract.
 */
export function ${extractLenientFnName}(
  text: string,
  opts?: ExtractOptions,
): ExtractionResult<${extractedName}> {
  const outcome = extract(text, ${schemaConstName}, opts);
  const d = outcome.data;
  const data: ${extractedName} = ${initializer};
  return { data, report: outcome.report };
}

/**
 * Extraction as a bool gate: \`true\` when the response was non-empty and no required
 * field was lost. On success, \`result\` carries the extracted mirror + report.
 */
export function ${tryExtractLenientName}(
  text: string,
): { ok: boolean; result: ExtractionResult<${extractedName}> } {
  const result = ${extractLenientFnName}(text);
  const ok = !result.report.isEmpty() && !result.report.hasLostRequired();
  return { ok, result };
}
`;

  // ---- Runtime-delegating extract (closes the nested gap) ----
  // Resolves this payload's MetaObject from a loaded MetaRoot by its baked simple name and
  // delegates to extractObject() in @metaobjectsdev/runtime-ts, which assembles the FULL nested
  // object graph reflection-free. The assembled ValueObject graph is then mapped into the typed
  // nullable mirror graph by the generated from<VO>Extracted mappers. Codegen-wrapping-runtime
  // (a generated DAO calling the dynamic-metadata runtime) — mirrors the Java/Kotlin pilots.
  //
  // The baked PAYLOAD_NAME is the resolved payload VO's SIMPLE name (root.findObject matches on
  // the object's `name`, not its FQN). The root mapper is named for the TEMPLATE (so it returns
  // the canonically-named `<Template>Extracted` mirror); nested mappers use their VO names.
  const payloadName = vo.name;
  const rootMapper = rootMapperName(templateName);
  const delegating = `
/** Payload value-object name this parser extracts — resolved against a loaded MetaRoot at runtime. */
export const ${payloadFqnConst} = ${JSON.stringify(payloadName)};

${nestedMappers(vo, root, rootMapper, extractedName)}

${delegateHelpers(usedHelpers(vo, root))}

/**
 * Runtime-delegating tolerant extraction; never throws. Unlike \`${extractLenientFnName}(text)\`, this FULLY
 * populates nested-object and array-of-object components by delegating to the metadata-driven
 * runtime \`extractObject\` (which assembles the whole graph reflection-free via the Phase A object
 * model), then maps the assembled graph into the typed \`${extractedName}\` mirror.
 *
 * @param root a loaded MetaRoot (e.g. \`(await new MetaDataLoader().load(...)).root\`) that declares
 *             the \`${payloadRef}\` value-object.
 */
export function ${extractLenientWithName}(
  root: MetaRoot,
  text: string,
  opts?: Partial<ExtractOptions> | null,
): ExtractionResult<${extractedName}> {
  const mo = root.findObject(${payloadFqnConst});
  if (mo === undefined) {
    throw new Error(\`${extractLenientWithName}: payload "\${${payloadFqnConst}}" not found in the supplied MetaRoot\`);
  }
  const outcome = extractObject(mo, text, ${formatEnum}, opts);
  return { data: ${rootMapper}(outcome.data), report: outcome.report };
}
`;

  // The delegating overload needs runtime-ts (extractObject) + the MetaRoot type from metadata.
  // It is always emitted (the gap-closing path), regardless of whether THIS payload has nested
  // fields — a flat payload still benefits from the loader-driven path and keeps the API uniform.
  void payloadHasNested;
  const metadataImport = `import type { MetaRoot } from "@metaobjectsdev/metadata";\n`;
  const runtimeImport = `import { extractObject } from "@metaobjectsdev/runtime-ts";\n`;

  return (
    `import { z } from "zod";\n` +
    `import {\n  ${renderImports.join(",\n  ")},\n} from "@metaobjectsdev/render";\n` +
    metadataImport +
    runtimeImport +
    `\n` +
    `${strictBody}\n` +
    `${selfContained}\n` +
    `${delegating}`
  );
}

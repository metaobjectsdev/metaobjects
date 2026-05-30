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
  mirrorInterface,
  mirrorInitializer,
} from "./recover-schema-emitter.js";
import { recoverMapHelpersUsed } from "./fr010-field-mapping.js";

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

  // FR-010: emit the tolerant recover() API alongside the strict Zod parser when the
  // template targets json/xml. The @payloadRef already resolved to a value-object above,
  // so a RecoverSchema can always be baked. text-format outputs get no recover.
  const format = (tmpl.ownAttr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text";
  const lc = format.toLowerCase();
  const emitRecover = lc === "json" || lc === "xml";

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

  if (!emitRecover) {
    return `import { z } from "zod";\n\n${strictBody}`;
  }

  // ---- FR-010 tolerant recover block (json/xml only) ----
  const recoveredName = `${templateName}Recovered`;
  const recoverFnName = `recover${templateName}`;
  const tryRecoverName = `tryRecover${templateName}`;
  const schemaConstName = `${templateName}RecoverSchema`;
  const schemaLit = schemaLiteral(vo, format, payloadRef);
  const mirrorDecl = mirrorInterface(vo, recoveredName);
  const initializer = mirrorInitializer(vo);
  const mapHelpers = recoverMapHelpersUsed(vo);

  // Render-package imports the recover block needs. Only pull in the names the emitted
  // source actually references, so the file has no unused imports (tsc noUnusedLocals-safe).
  const renderImports = ["recover", "recoverSchema", "Format"];
  if (schemaLit.includes("scalar(")) renderImports.push("scalar");
  if (schemaLit.includes("enumField(")) renderImports.push("enumField");
  if (schemaLit.includes("FieldKind.")) renderImports.push("FieldKind");
  renderImports.push("type RecoverSchema", "type RecoverOptions", "type RecoveryResult");
  renderImports.push(...mapHelpers);

  const recoverBody = `/** Baked recover descriptor for the ${templateName} output. */
const ${schemaConstName}: RecoverSchema = ${schemaLit};

${mirrorDecl}

/**
 * Tolerant best-effort recovery of a dirty LLM response; never throws. Returns a
 * nullable mirror (\`${recoveredName}\`) with fields null where lost/malformed,
 * plus the per-field recovery report.
 */
export function ${recoverFnName}(
  text: string,
  opts?: RecoverOptions,
): RecoveryResult<${recoveredName}> {
  const outcome = recover(text, ${schemaConstName}, opts);
  const d = outcome.data;
  const data: ${recoveredName} = ${initializer};
  return { data, report: outcome.report };
}

/**
 * Recovery as a bool gate: \`true\` when the response was non-empty and no required
 * field was lost. On success, \`result\` carries the recovered mirror + report.
 */
export function ${tryRecoverName}(
  text: string,
): { ok: boolean; result: RecoveryResult<${recoveredName}> } {
  const result = ${recoverFnName}(text);
  const ok = !result.report.isEmpty() && !result.report.hasLostRequired();
  return { ok, result };
}
`;

  return (
    `import { z } from "zod";\n` +
    `import {\n  ${renderImports.join(",\n  ")},\n} from "@metaobjectsdev/render";\n\n` +
    `${strictBody}\n` +
    `${recoverBody}`
  );
}

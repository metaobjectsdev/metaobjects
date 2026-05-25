// server/typescript/packages/codegen-ts/src/templates/output-parser.ts
//
// Per-template renderer for template.output codegen. Walks the @payloadRef's
// value-object into a Zod schema and emits a dual-API parser (parse + safeParse)
// alongside the schema. The emitted file imports the payload-VO type from
// "./payloads.js" — the outputParser() factory writes one file per template,
// so a consumer's project will have multiple <Name>.output.ts files all
// referencing the shared payloads file emitted by promptRender() (or by their
// own generator).

import {
  type MetaData,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  TEMPLATE_ATTR_PAYLOAD_REF,
} from "@metaobjectsdev/metadata";

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

/** Render a `z.object({ ... })` for an object.value node. */
function renderObjectSchema(vo: MetaData, root: MetaData, seen: ReadonlySet<string>, depth: number): string {
  const fields = vo.children().filter((c) => c.type === TYPE_FIELD);
  const fieldIndent = "  ".repeat(depth + 2);
  const closeIndent = "  ".repeat(depth + 1);
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
  const errorName = `${templateName}ValidationError`;
  const parseName = `parse${templateName}`;
  const safeParseName = `safeParse${templateName}`;

  return `import { z } from "zod";
import type { ${payloadRef} } from "./payloads.js";

const ${schemaName} = ${schema};

export type ${errorName} = z.ZodError;

/**
 * Parse an LLM response into a typed ${payloadRef}.
 * @throws ZodError on validation failure.
 */
export function ${parseName}(text: string): ${payloadRef} {
  return ${schemaName}.parse(JSON.parse(text)) as ${payloadRef};
}

/**
 * Parse an LLM response with explicit error handling (Result-style).
 * Does not throw on validation failure.
 */
export function ${safeParseName}(
  text: string,
): { success: true; data: ${payloadRef} } | { success: false; error: ${errorName} } {
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
    ? { success: true, data: result.data as ${payloadRef} }
    : { success: false, error: result.error };
}
`;
}

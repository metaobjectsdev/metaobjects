// Payload-type + render-handle codegen for prompt construction (FR-004 Plan #3, B).
//
// Emits the TYPED PAYLOAD as a language-idiomatic type (a TS `interface` here;
// a record/POJO when this ports to Java) and a typed render handle. Types only —
// no class, no runtime ValueObject; the render engine consumes a plain object,
// and structural typing gives the caller-side compile-time guarantee.
//
// NOTE (slice): the field→TS-type map is local here; the production generator
// should reuse codegen-ts's canonical field mapping + ts-poet emit + the
// Generator/runner integration. Assembler (RDB materialization + host overlay)
// is out of scope — this only emits the contract.

import {
  type MetaData,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_TEMPLATE,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_FORMAT,
} from "@metaobjectsdev/metadata";

const SCALAR_TS: Record<string, string> = {
  string: "string",
  class: "string",
  int: "number",
  short: "number",
  byte: "number",
  long: "number",
  double: "number",
  float: "number",
  decimal: "number",
  currency: "number",
  boolean: "boolean",
  date: "string",
  time: "string",
  timestamp: "string",
};

function findObject(root: MetaData, name: string): MetaData | undefined {
  return root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === name);
}

function fieldTsType(field: MetaData): { type: string; refVo?: string } {
  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    const ref = field.ownAttr(FIELD_ATTR_OBJECT_REF);
    const refName = typeof ref === "string" ? ref : "unknown";
    // isArray is a structural property on MetaData, not an attr.
    const isArray = field.isArray;
    const result: { type: string; refVo?: string } = {
      type: isArray ? `${refName}[]` : refName,
    };
    if (typeof ref === "string") result.refVo = ref;
    return result;
  }
  return { type: SCALAR_TS[field.subType] ?? "unknown" };
}

function emitInterface(root: MetaData, voName: string, emitted: Set<string>, out: string[]): void {
  if (emitted.has(voName)) return;
  const vo = findObject(root, voName);
  if (!vo) return;
  emitted.add(voName);
  const lines: string[] = [`export interface ${voName} {`];
  const refs: string[] = [];
  for (const f of vo.children().filter((c) => c.type === TYPE_FIELD)) {
    const { type, refVo } = fieldTsType(f);
    lines.push(`  ${f.name}: ${type};`);
    if (refVo) refs.push(refVo);
  }
  lines.push("}");
  out.push(lines.join("\n"));
  for (const r of refs) emitInterface(root, r, emitted, out);
}

/** Emit the payload `interface` (+ nested element interfaces) for an object.value view-object. */
export function generatePayloadInterfaces(root: MetaData, voName: string): string {
  const out: string[] = [];
  emitInterface(root, voName, new Set<string>(), out);
  return out.join("\n\n") + "\n";
}

function pascal(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Emit a typed render handle binding a template's @textRef + @format and typing its payload. */
export function generateRenderHandle(root: MetaData, templateName: string): string {
  const tmpl = root.ownChildren().find((c) => c.type === TYPE_TEMPLATE && c.name === templateName);
  if (!tmpl) throw new Error(`template "${templateName}" not found`);
  const payloadRef = tmpl.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
  const textRef = tmpl.ownAttr(TEMPLATE_ATTR_TEXT_REF);
  const format = (tmpl.ownAttr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text";
  const fn = `render${pascal(templateName)}`;
  return [
    `import { render, type Provider } from "@metaobjectsdev/render";`,
    `import type { ${payloadRef} } from "./payloads.js";`,
    ``,
    `export function ${fn}(payload: ${payloadRef}, provider: Provider): string {`,
    `  return render({ ref: ${JSON.stringify(textRef)}, payload, format: ${JSON.stringify(format)}, provider });`,
    `}`,
    ``,
  ].join("\n");
}

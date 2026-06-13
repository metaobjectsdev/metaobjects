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
  type MetaField,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_TEMPLATE,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_REQUIRED,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_FORMAT,
  refMatchesObject,
  stripPackage,
} from "@metaobjectsdev/metadata";
import { enumValues } from "./enum-meta.js";
import { enumUnionAliasName, enumUnionString } from "./templates/inferred-types.js";

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
  // FR-032 — @payloadRef/@responseRef are FQN after the desugar/sweep; match on
  // the effective FQN resolution key (with bare back-compat).
  return root.ownChildren().find((c) => c.type === TYPE_OBJECT && refMatchesObject(c, name));
}

/**
 * Map a payload field to its strict TS type.
 *  - `refVo`: the nested @objectRef VO to recurse into (object fields only).
 *  - `enumAlias`: a `{ name, decl }` for a `field.enum` — `name` is the union-alias
 *    type referenced inline; `decl` is the `export type <name> = "A" | "B";` line the
 *    caller hoists above the interface (deduped). Reuses the SAME naming + union
 *    logic as the entity inferred-types emitter (single source of truth).
 */
function fieldTsType(
  field: MetaData,
  ownerName: string,
): { type: string; refVo?: string; enumAlias?: { name: string; decl: string } } {
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
  // field.enum: a value-constrained string-literal union alias (NOT `unknown`).
  // Field nodes are MetaField instances at runtime (MetaField extends MetaData),
  // so the enum helpers (effective @values + super-resolving name) apply.
  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const values = enumValues(field as MetaField);
    if (values !== undefined) {
      const aliasName = enumUnionAliasName(ownerName, field as MetaField);
      return {
        type: field.isArray ? `${aliasName}[]` : aliasName,
        enumAlias: { name: aliasName, decl: `export type ${aliasName} = ${enumUnionString(values)};` },
      };
    }
    // No @values → fall through to the raw-string representation.
    return { type: field.isArray ? "string[]" : "string" };
  }
  const scalar = SCALAR_TS[field.subType] ?? "unknown";
  return { type: field.isArray ? `${scalar}[]` : scalar };
}

/** True iff the field's @required is explicitly set to true. */
function isFieldRequired(field: MetaData): boolean {
  return field.ownAttr(FIELD_ATTR_REQUIRED) === true;
}

function emitInterface(
  root: MetaData,
  voName: string,
  emitted: Set<string>,
  out: string[],
  enumAliases: Set<string>,
): void {
  if (emitted.has(voName)) return;
  const vo = findObject(root, voName);
  if (!vo) return;
  emitted.add(voName);
  const aliasLines: string[] = [];
  const lines: string[] = [`export interface ${voName} {`];
  const refs: string[] = [];
  for (const f of vo.children().filter((c) => c.type === TYPE_FIELD)) {
    const { type, refVo, enumAlias } = fieldTsType(f, voName);
    // Hoist the enum union alias above the interface, deduped across the whole
    // batch (multiple fields/objects can share one abstract enum's alias).
    if (enumAlias && !enumAliases.has(enumAlias.name)) {
      enumAliases.add(enumAlias.name);
      aliasLines.push(enumAlias.decl);
    }
    // Required fields: `name: T;`
    // Optional fields: `name?: T | null;` — the `| null` lets values from
    // Drizzle entity rows (which return `null` for nullable columns) flow
    // straight in. Without it, TS treats undefined-vs-null as a hard error
    // at the entity → payload boundary.
    const isRequired = isFieldRequired(f);
    const tsType = isRequired ? type : `${type} | null`;
    const optional = isRequired ? "" : "?";
    lines.push(`  ${f.name}${optional}: ${tsType};`);
    if (refVo) refs.push(refVo);
  }
  lines.push("}");
  const block = aliasLines.length > 0 ? `${aliasLines.join("\n")}\n${lines.join("\n")}` : lines.join("\n");
  out.push(block);
  for (const r of refs) emitInterface(root, r, emitted, out, enumAliases);
}

/** Emit the payload `interface` (+ nested element interfaces) for an object.value view-object. */
export function generatePayloadInterfaces(root: MetaData, voName: string): string {
  const out: string[] = [];
  emitInterface(root, voName, new Set<string>(), out, new Set<string>());
  return out.join("\n\n") + "\n";
}

/**
 * Emit interfaces for several payloads at once, using a single shared dedupe
 * set so nested types (e.g. lens projections referenced by multiple payloads)
 * appear exactly once in the combined output.
 *
 * Returns the empty string when `voNames` is empty.
 */
export function generatePayloadInterfacesBatch(root: MetaData, voNames: readonly string[]): string {
  if (voNames.length === 0) return "";
  const out: string[] = [];
  const emitted = new Set<string>();
  const enumAliases = new Set<string>();
  for (const name of voNames) {
    emitInterface(root, name, emitted, out, enumAliases);
  }
  return out.length === 0 ? "" : out.join("\n\n") + "\n";
}

function pascal(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Emit a typed render handle binding a template's @textRef + @format and typing its payload. */
export function generateRenderHandle(root: MetaData, templateName: string): string {
  const tmpl = root.ownChildren().find((c) => c.type === TYPE_TEMPLATE && c.name === templateName);
  if (!tmpl) throw new Error(`template "${templateName}" not found`);
  const payloadRef = tmpl.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
  // FR-032 — @payloadRef is an FQN after the desugar/sweep; the generated TS
  // TYPE NAME is the resolved value-object's bare name (an FQN like
  // `acme::ai::Payload` is not a valid TS identifier). Fall back to the last
  // `::`-segment when the VO is not in this root (defensive).
  const payloadType =
    (typeof payloadRef === "string" ? findObject(root, payloadRef)?.name : undefined) ??
    (typeof payloadRef === "string" ? stripPackage(payloadRef) : String(payloadRef));
  const textRef = tmpl.ownAttr(TEMPLATE_ATTR_TEXT_REF);
  const format = (tmpl.ownAttr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text";
  const fn = `render${pascal(templateName)}`;
  return [
    `import { render, type Provider } from "@metaobjectsdev/render";`,
    `import type { ${payloadType} } from "./payloads.js";`,
    ``,
    `export function ${fn}(payload: ${payloadType}, provider: Provider): string {`,
    `  return render({ ref: ${JSON.stringify(textRef)}, payload, format: ${JSON.stringify(format)}, provider });`,
    `}`,
    ``,
  ].join("\n");
}

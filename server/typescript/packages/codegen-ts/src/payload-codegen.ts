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
//
// ADR-0044 — collision-aware naming: emission is a THREE-PASS pipeline.
//   1. collectClosure    — walk the reference closure (FQN-exact resolution),
//                           collecting resolved VOs keyed by resolutionKey()
//                           (never bare name — bare-keyed dedupe silently drops
//                           the second same-short-name VO; #219/#220).
//   2. assignEmittedNames — a PURE function of the closure: a bare short name
//                           unique in the closure emits bare; a collision emits
//                           EVERY member under its package-qualified derived
//                           name (PascalCase each package segment + short name).
//                           A still-colliding derived name fails loud. Lives in
//                           ./naming/collision-names.js — shared with the
//                           entity + extract/output-parser tiers (#228).
//   3. emitClosureDeclarations — emit each declaration + every reference through
//                           the name map.

import {
  type MetaData,
  type MetaField,
  TYPE_FIELD,
  TYPE_TEMPLATE,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_REQUIRED,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_FORMAT,
  resolveObjectRef,
  stripPackage,
} from "@metaobjectsdev/metadata";
import { enumValues } from "./enum-meta.js";
import { enumUnionAliasName, enumUnionString } from "./templates/inferred-types.js";
import { assignEmittedNames } from "./naming/collision-names.js";

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

// ADR-0039: resolving — root has no super (children()==ownChildren()); a top-level object/template may itself extend, so resolve rather than work-by-accident.
// ADR-0042: resolveObjectRef gives package-local-before-root-level precedence for a bare ref, FQN-exact otherwise.
function findObject(root: MetaData, name: string, referrerPkg = ""): MetaData | undefined {
  return resolveObjectRef(root, name, referrerPkg).node;
}

/**
 * ADR-0044 pass 1 — walk `voRef`'s transitive `@objectRef` closure with FQN-exact
 * resolution, collecting resolved VOs keyed by `resolutionKey()` (never bare name
 * — the #219/#220 defect). `visited` accumulates across multiple root calls so a
 * batch emission (`generatePayloadInterfacesBatch`) shares ONE collision domain,
 * per the ADR-0044 "closure of the payload root(s) emitted into one artifact"
 * definition. A VO already in `visited` is not re-walked (cycle/dedupe guard).
 */
function collectClosure(
  root: MetaData,
  voRef: string,
  referrerPkg: string,
  visited: Map<string, MetaData>,
): void {
  const vo = findObject(root, voRef, referrerPkg);
  if (!vo) return;
  const fqn = vo.resolutionKey();
  if (visited.has(fqn)) return;
  visited.set(fqn, vo);
  // ADR-0042: a nested @objectRef resolves in the FIELD's OWN declaring package —
  // which may differ from this resolved VO's package when the field is inherited
  // via extends from an abstract VO in another package (the bare ref was authored
  // there). Fall back to this VO's package when a field has no parent package.
  const voPkg = vo.package ?? vo.fileDefaultPackage ?? "";
  for (const f of vo.children().filter((c) => c.type === TYPE_FIELD)) {
    if (f.subType !== FIELD_SUBTYPE_OBJECT) continue;
    const ref = f.attr(FIELD_ATTR_OBJECT_REF);
    if (typeof ref !== "string") continue;
    const fieldPkg = f.parent?.package ?? f.parent?.fileDefaultPackage ?? voPkg;
    collectClosure(root, ref, fieldPkg, visited);
  }
}

/** Resolve `ref`'s emitted TS interface name under the ADR-0044 naming rule,
 *  scoped to `ref`'s OWN reference closure (the same closure
 *  `generatePayloadInterfaces(root, ref, referrerPkg)` would emit). Returns
 *  undefined only when `ref` resolves to nothing — this resolver is
 *  SUBTYPE-BLIND (any resolved object gets a name); the legal template-level
 *  target set (object.value or sourceless object.projection, #210) is
 *  enforced by the loader, never re-checked here. */
function resolveEmittedName(root: MetaData, ref: string, referrerPkg: string): string | undefined {
  const vo = findObject(root, ref, referrerPkg);
  if (!vo) return undefined;
  const closure = new Map<string, MetaData>();
  collectClosure(root, ref, referrerPkg, closure);
  return assignEmittedNames(closure).get(vo.resolutionKey());
}

/**
 * Map a non-object payload field to its strict TS type.
 *  - `enumAlias`: a `{ name, decl }` for a `field.enum` — `name` is the union-alias
 *    type referenced inline; `decl` is the `export type <name> = "A" | "B";` line the
 *    caller hoists above the interface (deduped). Reuses the SAME naming + union
 *    logic as the entity inferred-types emitter (single source of truth).
 *  Object (`field.object`) fields are NOT handled here — their type comes from the
 *  ADR-0044 closure name map, resolved by the caller (the ref may need
 *  package-qualification the field alone can't determine).
 */
function fieldTsType(
  field: MetaData,
  ownerName: string,
): { type: string; enumAlias?: { name: string; decl: string } } {
  // field.enum: a value-constrained string-literal union alias (NOT `unknown`).
  // Field nodes are MetaField instances at runtime (MetaField extends MetaData),
  // so the enum helpers (effective @values + super-resolving name) apply.
  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const values = enumValues(field as MetaField);
    if (values !== undefined) {
      const aliasName = enumUnionAliasName(ownerName, field as MetaField);
      return {
        type: field.resolvedIsArray() ? `${aliasName}[]` : aliasName,
        enumAlias: { name: aliasName, decl: `export type ${aliasName} = ${enumUnionString(values)};` },
      };
    }
    // No @values → fall through to the raw-string representation.
    return { type: field.resolvedIsArray() ? "string[]" : "string" };
  }
  const scalar = SCALAR_TS[field.subType] ?? "unknown";
  return { type: field.resolvedIsArray() ? `${scalar}[]` : scalar };
}

/** True iff the field's @required is explicitly set to true. */
function isFieldRequired(field: MetaData): boolean {
  return field.attr(FIELD_ATTR_REQUIRED) === true;
}

/**
 * ADR-0044 pass 3 — emit `export interface <emittedName> { ... }` for every VO in
 * the closure, in closure-visitation order, using `nameMap` for both the
 * declaration name and every nested `field.object` reference's type.
 */
function emitClosureDeclarations(
  root: MetaData,
  closure: ReadonlyMap<string, MetaData>,
  nameMap: ReadonlyMap<string, string>,
  out: string[],
  enumAliases: Set<string>,
): void {
  for (const [, vo] of closure) {
    const voName = nameMap.get(vo.resolutionKey())!;
    const voPkg = vo.package ?? vo.fileDefaultPackage ?? "";
    const aliasLines: string[] = [];
    const lines: string[] = [`export interface ${voName} {`];
    for (const f of vo.children().filter((c) => c.type === TYPE_FIELD)) {
      let type: string;
      let enumAlias: { name: string; decl: string } | undefined;
      if (f.subType === FIELD_SUBTYPE_OBJECT) {
        const ref = f.attr(FIELD_ATTR_OBJECT_REF);
        if (typeof ref === "string") {
          // The nested ref resolves in the FIELD's declaring package (ADR-0042),
          // not the resolved VO's — they differ when `f` is inherited from an
          // abstract VO elsewhere.
          const fieldPkg = f.parent?.package ?? f.parent?.fileDefaultPackage ?? voPkg;
          const refNode = findObject(root, ref, fieldPkg);
          // refNode was walked into the closure by collectClosure — the name map
          // always has it. The stripPackage fallback only guards a defensive gap
          // (e.g. a caller-constructed closure that skipped pass 1).
          const refName = (refNode && nameMap.get(refNode.resolutionKey())) ?? stripPackage(ref);
          type = f.resolvedIsArray() ? `${refName}[]` : refName;
        } else {
          type = "unknown";
        }
      } else {
        const r = fieldTsType(f, voName);
        type = r.type;
        enumAlias = r.enumAlias;
      }
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
    }
    lines.push("}");
    const block = aliasLines.length > 0 ? `${aliasLines.join("\n")}\n${lines.join("\n")}` : lines.join("\n");
    out.push(block);
  }
}

/** Emit the payload `interface` (+ nested element interfaces) for a payload shape — an
 *  object.value or sourceless object.projection (#210; the loader owns the target-set
 *  constraint, this emitter is subtype-blind).
 *  `referrerPkg` (ADR-0042) is the package a bare `voName` resolves in; pass an FQN and it is ignored.
 *  ADR-0044: a short-name collision within `voName`'s reference closure emits EVERY colliding
 *  member under its package-qualified derived name; a non-colliding closure emits byte-identical
 *  bare names (unchanged from pre-ADR-0044 output). */
export function generatePayloadInterfaces(root: MetaData, voName: string, referrerPkg = ""): string {
  const closure = new Map<string, MetaData>();
  collectClosure(root, voName, referrerPkg, closure);
  const nameMap = assignEmittedNames(closure);
  const out: string[] = [];
  emitClosureDeclarations(root, closure, nameMap, out, new Set<string>());
  return out.join("\n\n") + "\n";
}

/**
 * Emit interfaces for several payloads at once, using a SINGLE shared reference
 * closure (ADR-0044: the closure of ALL the given roots together is the collision
 * domain for this call) so nested types (e.g. lens projections referenced by
 * multiple payloads) appear exactly once, and a short-name collision anywhere
 * across the whole batch is caught and qualified consistently.
 *
 * Returns the empty string when `voNames` is empty.
 */
export function generatePayloadInterfacesBatch(
  root: MetaData,
  voNames: readonly string[],
  referrerPkg = "",
): string {
  if (voNames.length === 0) return "";
  const closure = new Map<string, MetaData>();
  for (const name of voNames) {
    collectClosure(root, name, referrerPkg, closure);
  }
  if (closure.size === 0) return "";
  const nameMap = assignEmittedNames(closure);
  const out: string[] = [];
  emitClosureDeclarations(root, closure, nameMap, out, new Set<string>());
  return out.length === 0 ? "" : out.join("\n\n") + "\n";
}

function pascal(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Emit a typed render handle binding a template's @textRef + @format and typing its payload. */
export function generateRenderHandle(root: MetaData, templateName: string): string {
  const tmpl = root.children().find((c) => c.type === TYPE_TEMPLATE && c.name === templateName);
  if (!tmpl) throw new Error(`template "${templateName}" not found`);
  // ADR-0039: resolving — a template may inherit its @* refs/format/kind via extends.
  const payloadRef = tmpl.attr(TEMPLATE_ATTR_PAYLOAD_REF);
  // FR-032 — @payloadRef is an FQN after the desugar/sweep; the generated TS
  // TYPE NAME is the resolved value-object's ADR-0044 emitted name (bare when
  // unique in its closure, package-qualified on a short-name collision). Fall
  // back to the last `::`-segment when the VO is not in this root (defensive).
  const payloadType =
    (typeof payloadRef === "string" ? resolveEmittedName(root, payloadRef, "") : undefined) ??
    (typeof payloadRef === "string" ? stripPackage(payloadRef) : String(payloadRef));
  // ADR-0039: resolving — a template may inherit its @* refs/format/kind via extends.
  const textRef = tmpl.attr(TEMPLATE_ATTR_TEXT_REF);
  const format = (tmpl.attr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text";
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

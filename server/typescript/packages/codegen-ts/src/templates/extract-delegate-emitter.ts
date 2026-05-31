// server/typescript/packages/codegen-ts/src/templates/extract-delegate-emitter.ts
//
// FR-010 Plan 2.1 (nested codegen gap) — the runtime-DELEGATING extract emitter.
//
// The self-contained extract<Name>(text) path (extract-schema-emitter + the baked
// ExtractSchema) covers scalars / enums / scalar-arrays but leaves nested-object and
// array-of-object components NULL — the historical FR-010 codegen gap. This module emits
// the additive delegating overload that CLOSES that gap by wrapping the runtime extract:
//
//   extract<Name>(root: MetaRoot, text, opts?) -> ExtractionResult<<Name>Extracted>
//
// It resolves this payload's MetaObject by its baked simple name from the supplied MetaRoot,
// delegates to extractObject() in @metaobjectsdev/runtime-ts (which assembles the FULL nested
// object graph reflection-free via the Phase A object model — MetaObject.newInstance() + the
// MetaField SPI), then maps the assembled ValueObject graph into the typed nullable mirror
// graph via generated from<VO>(...) mapper functions (payload + every nested VO, deduped).
//
// This is the codegen-wrapping-runtime pattern (a generated DAO calling the dynamic-metadata
// runtime), mirroring the Java SpringOutputParserGenerator + Kotlin pilots. The generated
// mappers read the assembled graph through a tiny readProp() helper that mirrors the MetaField
// getValue SPI (ValueObject.get(name) else plain-property access), so the emitted code stays
// self-sufficient and reflection-free.

import {
  type MetaData,
  TYPE_OBJECT,
  TYPE_FIELD,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_OBJECT_REF,
  PACKAGE_SEPARATOR,
} from "@metaobjectsdev/metadata";
import { fields, isArray, scalarKind, jsonStringLiteral } from "./fr010-field-mapping.js";

function findObject(root: MetaData, name: string): MetaData | undefined {
  return root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === name);
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

/** True iff the field is a nested object reference (field.object — distinct from the
 *  string-backed field.enum, which is treated as a scalar). */
function isObjectField(field: MetaData): boolean {
  return field.subType === FIELD_SUBTYPE_OBJECT;
}

/** The extracted-mirror interface name for a value-object (`<Name>Extracted`). */
export function mirrorName(vo: MetaData): string {
  return `${vo.name}Extracted`;
}

/** The mapper function name for a value-object (`from<Name>Extracted`). */
function mapperName(vo: MetaData): string {
  return `from${vo.name}Extracted`;
}

// =============================================================================
// Nested-aware mirror interfaces (payload + every reachable nested VO)
// =============================================================================

/** The nullable mirror TS type for one field — nested-aware (recurses into nested mirror names). */
function nestedMirrorType(field: MetaData, root: MetaData): string {
  if (isObjectField(field)) {
    const target = refVo(field, root);
    const base = target !== undefined ? mirrorName(target) : "unknown";
    const elem = `${base} | null`;
    return isArray(field) ? `(${elem})[] | null` : elem;
  }
  if (isArray(field)) return "(string | null)[] | null";
  if (field.subType === FIELD_SUBTYPE_ENUM) return "string | null";
  switch (scalarKind(field.subType)) {
    case "INT":
    case "LONG":
    case "DOUBLE":
      return "number | null";
    case "BOOLEAN":
      return "boolean | null";
    default:
      return "string | null";
  }
}

/**
 * Emit the nested-aware mirror interface for `vo` and every value-object reachable from it
 * (deduped by simple name; cycle-safe). The payload mirror keeps the canonical `<Payload>Extracted`
 * name (passed in) so the existing self-contained extract<Name>() and the delegating overload
 * share one mirror type. Returns the joined interface declarations in stable (BFS) order.
 */
export function nestedMirrorInterfaces(vo: MetaData, root: MetaData, payloadMirror: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  emitMirror(vo, root, payloadMirror, seen, out);
  return out.join("\n\n");
}

function emitMirror(
  vo: MetaData,
  root: MetaData,
  interfaceName: string,
  seen: Set<string>,
  out: string[],
): void {
  if (seen.has(vo.name)) return;
  seen.add(vo.name);

  const base = interfaceName.endsWith("Extracted")
    ? interfaceName.slice(0, -"Extracted".length)
    : interfaceName;
  const lines: string[] = [];
  lines.push(
    `/** Best-effort extracted twin of \`${base}\` — every field nullable (null where lost/malformed). */`,
  );
  lines.push(`export interface ${interfaceName} {`);
  for (const f of fields(vo)) {
    lines.push(`  ${f.name}: ${nestedMirrorType(f, root)};`);
  }
  lines.push("}");
  out.push(lines.join("\n"));

  // Recurse into nested VOs (post-order via the shared seen set → dedupe + cycle guard).
  for (const f of fields(vo)) {
    if (isObjectField(f)) {
      const target = refVo(f, root);
      if (target !== undefined) emitMirror(target, root, mirrorName(target), seen, out);
    }
  }
}

// =============================================================================
// Mapper functions (assembled ValueObject graph -> typed nullable mirror graph)
// =============================================================================

/**
 * Emit one `from<VO>Extracted(o)` mapper per value-object reachable from `vo` (payload + nested,
 * deduped). Each mapper reads the assembled object via readProp() and recurses into nested
 * mappers for object/array-of-object components. Nested mappers use `from<NestedName>Extracted`
 * returning `<NestedName>Extracted`. The ROOT mapper is overridden to the template-derived names
 * (`rootMapperFn` / `rootMirror`) so it matches the canonically-named root mirror interface — the
 * payload VO's own name may differ from the template name.
 */
export function nestedMappers(
  vo: MetaData,
  root: MetaData,
  rootMapperFn: string,
  rootMirror: string,
): string {
  const out: string[] = [];
  const seen = new Set<string>();
  emitMapper(vo, root, seen, out, { fn: rootMapperFn, mirror: rootMirror });
  return out.join("\n\n");
}

/** The root mapper's name + mirror — derived from the template, not the payload VO. */
export function rootMapperName(template: string): string {
  return `from${template}Extracted`;
}

function emitMapper(
  vo: MetaData,
  root: MetaData,
  seen: Set<string>,
  out: string[],
  override?: { fn: string; mirror: string },
): void {
  if (seen.has(vo.name)) return;
  seen.add(vo.name);

  const fn = override?.fn ?? mapperName(vo);
  const mir = override?.mirror ?? mirrorName(vo);
  const assigns = fields(vo).map((f) => `    ${f.name}: ${mapperArg(f, root)},`);
  const body = [
    `/** Map an assembled ValueObject graph into a typed \`${mir}\` mirror. Generated; null-tolerant. */`,
    `function ${fn}(o: unknown): ${mir} | null {`,
    `  if (o == null) return null;`,
    `  return {`,
    ...assigns,
    `  };`,
    `}`,
  ].join("\n");
  out.push(body);

  for (const f of fields(vo)) {
    if (isObjectField(f)) {
      const target = refVo(f, root);
      if (target !== undefined) emitMapper(target, root, seen, out);
    }
  }
}

/** The mirror-field initializer expression that reads `field` from the assembled object `o`. */
function mapperArg(field: MetaData, root: MetaData): string {
  const key = jsonStringLiteral(field.name);

  if (isObjectField(field)) {
    const target = refVo(field, root);
    if (target === undefined) return "null /* unresolved @objectRef */";
    const fn = mapperName(target);
    if (isArray(field)) {
      return `mapObjectList(readProp(o, ${key}), ${fn})`;
    }
    return `${fn}(readProp(o, ${key}))`;
  }

  // Enum / scalar / scalar-array: the runtime already coerced; read + light-coerce to the
  // mirror's nullable shape via the locally-defined dlg* readers. (These are distinct from the
  // render ExtractMap helpers `asString(d, key)` etc., which the self-contained path imports — a
  // local helper must NOT shadow those, so the delegate readers carry the `dlg` prefix.)
  if (field.subType === FIELD_SUBTYPE_ENUM) return `dlgString(readProp(o, ${key}))`;
  if (isArray(field)) return `dlgStringList(readProp(o, ${key}))`;
  switch (scalarKind(field.subType)) {
    case "INT":
    case "LONG":
      return `dlgInt(readProp(o, ${key}))`;
    case "DOUBLE":
      return `dlgNumber(readProp(o, ${key}))`;
    case "BOOLEAN":
      return `dlgBool(readProp(o, ${key}))`;
    default:
      return `dlgString(readProp(o, ${key}))`;
  }
}

/**
 * The set of generated-helper names the mappers for `vo` (+ reachable nested VOs) actually
 * reference. Used to emit only the needed helpers (consumer projects may run noUnusedLocals).
 * `readProp` + at least one dlg* reader are always present once any mapper is emitted.
 */
export function usedHelpers(vo: MetaData, root: MetaData): Set<string> {
  const used = new Set<string>(["readProp"]);
  const seen = new Set<string>();
  const stack = [vo];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur.name)) continue;
    seen.add(cur.name);
    for (const f of fields(cur)) {
      if (isObjectField(f)) {
        const target = refVo(f, root);
        if (target === undefined) continue;
        stack.push(target);
        if (isArray(f)) used.add("mapObjectList");
        continue;
      }
      if (f.subType === FIELD_SUBTYPE_ENUM) {
        used.add("dlgString");
      } else if (isArray(f)) {
        used.add("dlgStringList");
      } else {
        switch (scalarKind(f.subType)) {
          case "INT":
          case "LONG":
            used.add("dlgInt");
            break;
          case "DOUBLE":
            used.add("dlgNumber");
            break;
          case "BOOLEAN":
            used.add("dlgBool");
            break;
          default:
            used.add("dlgString");
        }
      }
    }
  }
  return used;
}

/** True iff the payload (or any reachable nested VO) has a nested-object / array-of-object field. */
export function hasNested(vo: MetaData, root: MetaData): boolean {
  const seen = new Set<string>();
  const stack = [vo];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur.name)) continue;
    seen.add(cur.name);
    for (const f of cur.children().filter((c) => c.type === TYPE_FIELD)) {
      if (isObjectField(f)) {
        const target = refVo(f, root);
        if (target !== undefined) {
          stack.push(target);
        }
        // a nested object field exists regardless of resolvability → still "has nested"
        if (f.subType === FIELD_SUBTYPE_OBJECT) return true;
      }
    }
  }
  return false;
}

/**
 * The shared runtime-side helper block the generated mappers rely on:
 *   • readProp  — null-tolerant read mirroring the MetaField getValue SPI (ValueObject.get(name)
 *                 else plain-property access); keeps the mappers reflection-free + backing-agnostic.
 *   • mapObjectList — map each element of an assembled array via a per-element mapper.
 *   • dlg* readers — light null-tolerant coercion to the mirror's nullable scalar shapes. The
 *     `dlg` prefix avoids shadowing the render ExtractMap helpers (`asString(d, key)` etc.) that
 *     the self-contained extract path imports into the SAME file — a collision would silently
 *     rebind those two-arg map readers to these one-arg readers.
 * Emitted once per parser file.
 */
export function delegateHelpers(used: Set<string>): string {
  const blocks: string[] = ["// ---- runtime-delegating extract helpers (generated) ----"];

  // readProp is always needed once a mapper exists.
  blocks.push(`/** Read a property from an assembled backing object, mirroring the MetaField getValue SPI. */
function readProp(o: unknown, name: string): unknown {
  if (o == null) return undefined;
  const vo = o as { get?: (n: string) => unknown };
  if (typeof vo.get === "function") return vo.get(name);
  return (o as Record<string, unknown>)[name];
}`);

  if (used.has("mapObjectList")) {
    blocks.push(`/** Map each element of an assembled array via \`fn\`; null/absent -> null; non-mappable -> filtered. */
function mapObjectList<T>(v: unknown, fn: (o: unknown) => T | null): (T | null)[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((e) => fn(e));
}`);
  }
  if (used.has("dlgString")) {
    blocks.push(`function dlgString(v: unknown): string | null {
  return v == null ? null : String(v);
}`);
  }
  if (used.has("dlgInt")) {
    blocks.push(`function dlgInt(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}`);
  }
  if (used.has("dlgNumber")) {
    blocks.push(`function dlgNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}`);
  }
  if (used.has("dlgBool")) {
    blocks.push(`function dlgBool(v: unknown): boolean | null {
  if (v == null) return null;
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true";
}`);
  }
  if (used.has("dlgStringList")) {
    blocks.push(`function dlgStringList(v: unknown): (string | null)[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((e) => (e == null ? null : String(e)));
}`);
  }
  return blocks.join("\n\n");
}

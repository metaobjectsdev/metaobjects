// server/typescript/packages/codegen-ts/src/templates/extract-delegate-emitter.ts
//
// FR-010 — the runtime-DELEGATING extract emitter (the single metadata-driven extract path).
//
// This module emits the loader-delegating extract entry point that reads the live metadata
// directly and populates nested-object and array-of-object components in full:
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
  TYPE_FIELD,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_OBJECT_REF,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";
import { fields, isArray, scalarKind, jsonStringLiteral } from "./fr010-field-mapping.js";
import type { RenderContext } from "../render-context.js";

// ADR-0039: resolving — root has no super (children()==ownChildren()); a top-level object/template may itself extend, so resolve rather than work-by-accident.
// ADR-0042: resolveObjectRef gives package-local-before-root-level precedence for a bare ref, FQN-exact otherwise.
function findObject(root: MetaData, name: string, referrerPkg = ""): MetaData | undefined {
  return resolveObjectRef(root, name, referrerPkg).node;
}

/** The @objectRef target VO for a nested-object field, or undefined when unresolvable. */
function refVo(field: MetaData, root: MetaData): MetaData | undefined {
  const ref = field.attr(FIELD_ATTR_OBJECT_REF);
  if (typeof ref !== "string") return undefined;
  // ADR-0042: resolve as authored — a bare ref binds the declaring VO's package,
  // an FQN exactly; NO bare-tail fallback (never bind a same-named VO elsewhere).
  return findObject(root, ref, field.parent?.package ?? field.parent?.fileDefaultPackage ?? "");
}

/** True iff the field is a nested object reference (field.object — distinct from the
 *  string-backed field.enum, which is treated as a scalar). */
function isObjectField(field: MetaData): boolean {
  return field.subType === FIELD_SUBTYPE_OBJECT;
}

/** The extracted-mirror interface name for a value-object (`<Name>Extracted`). ADR-0044/#228:
 *  `ctx` (optional) resolves the collision-scoped entity-domain emitted name (Task 3's
 *  `valueObjectEmittedName`), so a cross-package short-name collision qualifies both the
 *  entity module AND its extract mirror identically (`AcmeAlphaNoteExtracted`). Omitted →
 *  the bare `vo.name` (bare template unit-test calls; byte-identical to pre-#228 output). */
export function mirrorName(vo: MetaData, ctx?: RenderContext): string {
  const name = ctx ? ctx.valueObjectEmittedName(vo) : vo.name;
  return `${name}Extracted`;
}

/** The mapper function name for a value-object (`from<Name>Extracted`). See {@link mirrorName}. */
function mapperName(vo: MetaData, ctx?: RenderContext): string {
  const name = ctx ? ctx.valueObjectEmittedName(vo) : vo.name;
  return `from${name}Extracted`;
}

// =============================================================================
// Nested-aware mirror interfaces (payload + every reachable nested VO)
// =============================================================================

/** The nullable mirror TS type for one field — nested-aware (recurses into nested mirror names). */
function nestedMirrorType(field: MetaData, root: MetaData, ctx?: RenderContext): string {
  if (isObjectField(field)) {
    const target = refVo(field, root);
    const base = target !== undefined ? mirrorName(target, ctx) : "unknown";
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
export function nestedMirrorInterfaces(
  vo: MetaData,
  root: MetaData,
  payloadMirror: string,
  ctx?: RenderContext,
): string {
  const out: string[] = [];
  const seen = new Set<string>();
  emitMirror(vo, root, payloadMirror, seen, out, ctx);
  return out.join("\n\n");
}

function emitMirror(
  vo: MetaData,
  root: MetaData,
  interfaceName: string,
  seen: Set<string>,
  out: string[],
  ctx?: RenderContext,
): void {
  // ADR-0044/#228: dedupe by resolutionKey(), NOT the bare name — two distinct value-objects
  // sharing a bare short name across packages (the collision case) are DIFFERENT nodes with
  // DIFFERENT resolutionKey()s; bare-name dedupe would treat the second as "already seen" and
  // silently DROP its mirror interface (and every mapper reading it downstream).
  if (seen.has(vo.resolutionKey())) return;
  seen.add(vo.resolutionKey());

  const base = interfaceName.endsWith("Extracted")
    ? interfaceName.slice(0, -"Extracted".length)
    : interfaceName;
  const lines: string[] = [];
  lines.push(
    `/** Best-effort extracted twin of \`${base}\` — every field nullable (null where lost/malformed). */`,
  );
  lines.push(`export interface ${interfaceName} {`);
  for (const f of fields(vo)) {
    lines.push(`  ${f.name}: ${nestedMirrorType(f, root, ctx)};`);
  }
  lines.push("}");
  out.push(lines.join("\n"));

  // Recurse into nested VOs (post-order via the shared seen set → dedupe + cycle guard).
  for (const f of fields(vo)) {
    if (isObjectField(f)) {
      const target = refVo(f, root);
      if (target !== undefined) emitMirror(target, root, mirrorName(target, ctx), seen, out, ctx);
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
  ctx?: RenderContext,
): string {
  const out: string[] = [];
  const seen = new Set<string>();
  emitMapper(vo, root, seen, out, { fn: rootMapperFn, mirror: rootMirror }, ctx);
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
  ctx?: RenderContext,
): void {
  // ADR-0044/#228: dedupe by resolutionKey() — see emitMirror for why bare-name dedupe drops
  // the second colliding VO's mapper (silently misdirecting its extraction to the FIRST
  // colliding VO's mapper — the exact wrong-data bug closed by this fix).
  if (seen.has(vo.resolutionKey())) return;
  seen.add(vo.resolutionKey());

  const fn = override?.fn ?? mapperName(vo, ctx);
  const mir = override?.mirror ?? mirrorName(vo, ctx);
  const assigns = fields(vo).map((f) => `    ${f.name}: ${mapperArg(f, root, ctx)},`);
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
      if (target !== undefined) emitMapper(target, root, seen, out, undefined, ctx);
    }
  }
}

/** The mirror-field initializer expression that reads `field` from the assembled object `o`. */
function mapperArg(field: MetaData, root: MetaData, ctx?: RenderContext): string {
  const key = jsonStringLiteral(field.name);

  if (isObjectField(field)) {
    const target = refVo(field, root);
    if (target === undefined) return "null /* unresolved @objectRef */";
    const fn = mapperName(target, ctx);
    if (isArray(field)) {
      return `mapObjectList(readProp(o, ${key}), ${fn})`;
    }
    return `${fn}(readProp(o, ${key}))`;
  }

  // Enum / scalar / scalar-array: the runtime already coerced; read + light-coerce to the
  // mirror's nullable shape via the locally-defined dlg* readers. (These are distinct from the
  // render ExtractMap helpers `asString(d, key)` etc., which the self-contained path imports — a
  // local helper must NOT shadow those, so the delegate readers carry the `dlg` prefix.)
  // An enum ARRAY is string-backed PER ELEMENT — it must use the list reader, NOT dlgString
  // (which would String()-collapse the whole array into "A,B"). Check isArray before the enum
  // scalar case. The mirror TYPE for an enum array is already `(string | null)[] | null` (see
  // mirrorFieldType), so the list reader matches.
  if (field.subType === FIELD_SUBTYPE_ENUM && isArray(field)) return `dlgStringList(readProp(o, ${key}))`;
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
    // ADR-0044/#228: dedupe by resolutionKey() — bare-name dedupe would skip walking the
    // SECOND colliding VO's fields entirely, silently missing a helper only IT needs.
    if (seen.has(cur.resolutionKey())) continue;
    seen.add(cur.resolutionKey());
    for (const f of fields(cur)) {
      if (isObjectField(f)) {
        const target = refVo(f, root);
        if (target === undefined) continue;
        stack.push(target);
        if (isArray(f)) used.add("mapObjectList");
        continue;
      }
      if (f.subType === FIELD_SUBTYPE_ENUM && isArray(f)) {
        used.add("dlgStringList");
      } else if (f.subType === FIELD_SUBTYPE_ENUM) {
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
    // ADR-0044/#228: dedupe by resolutionKey() (see usedHelpers).
    if (seen.has(cur.resolutionKey())) continue;
    seen.add(cur.resolutionKey());
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

// Package-driven output placement — path + import-specifier computation.
// In "flat" mode every function returns exactly today's value, so flat
// output is byte-identical. See
// docs/superpowers/specs/2026-05-18-phase4d-package-output-placement-design.md.

import { relative as posixRelative } from "node:path/posix";
import { PACKAGE_SEPARATOR } from "@metaobjectsdev/metadata";
import { withExt, type ExtStyle } from "./render-context.js";

export type OutputLayout = "flat" | "package";

/** "a::b::c" → "a/b/c"; undefined / "" → "". */
export function packageToPath(pkg: string | undefined): string {
  if (pkg === undefined || pkg === "") return "";
  return pkg.split(PACKAGE_SEPARATOR).join("/");
}

/** Output path (relative to outDir) for an entity's generated file. */
export function entityOutputPath(
  layout: OutputLayout,
  pkg: string | undefined,
  filename: string,
): string {
  if (layout === "flat") return filename;
  const dir = packageToPath(pkg);
  return dir === "" ? filename : `${dir}/${filename}`;
}

/** Relative dir prefix (ending in "/") from `fromDir` to `toDir`, both
 *  POSIX paths relative to outDir. Same dir → "./". */
function relativeDirPrefix(fromDir: string, toDir: string): string {
  let rel = posixRelative(fromDir, toDir);
  if (rel === "") rel = ".";
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return `${rel}/`;
}

/** Module specifier to import `toEntity` (in `toPkg`) from a file in `fromPkg`.
 *  Flat → always "./<toEntity>". */
export function crossEntitySpecifier(
  layout: OutputLayout,
  fromPkg: string | undefined,
  toPkg: string | undefined,
  toEntity: string,
  extStyle: ExtStyle,
): string {
  if (layout === "flat") return withExt(`./${toEntity}`, extStyle);
  const prefix = relativeDirPrefix(packageToPath(fromPkg), packageToPath(toPkg));
  return withExt(`${prefix}${toEntity}`, extStyle);
}

/**
 * Module specifier to import a value-object's emitted module (`<VO>.ts`) from a
 * file that lives in `fromPkg`. Value objects are emitted by the entity-file
 * generator into the SAME target as entities, so this is the same same-target,
 * package- + extStyle-aware resolution that FK references use.
 *
 * This is the SINGLE source of truth shared by the three places that reference a
 * VO — the field's TS type (inferred-types), its runtime Zod schema
 * (zod-validators), and its Drizzle `.$type<>()` (drizzle-schema). They MUST
 * resolve a given VO to the identical module or they would import two distinct
 * symbols; routing all three through this function makes divergence impossible.
 *
 * `voPkg` is looked up from `packageOf` (which includes `object.value` nodes —
 * `root.objects()` returns every `TYPE_OBJECT` child). An unknown VO falls back
 * to `fromPkg`, yielding a same-dir `./<VO>` specifier (correct for flat layout
 * and for a same-package reference).
 */
export function valueObjectModuleSpecifier(
  voName: string,
  packageOf: ReadonlyMap<string, string | undefined>,
  fromPkg: string | undefined,
  layout: OutputLayout,
  extStyle: ExtStyle,
): string {
  const voPkg = packageOf.has(voName) ? packageOf.get(voName) : fromPkg;
  return crossEntitySpecifier(layout, fromPkg, voPkg, voName, extStyle);
}

/** Barrel (at outDir root) re-export specifier for an entity.
 *  Equivalent to crossEntitySpecifier with fromPkg=undefined (barrel is always at root). */
export function barrelEntrySpecifier(
  layout: OutputLayout,
  pkg: string | undefined,
  entity: string,
  extStyle: ExtStyle,
): string {
  return crossEntitySpecifier(layout, undefined, pkg, entity, extStyle);
}

/** A `dbImport` (or any module specifier) adjusted for a file at the given
 *  package depth. A non-relative specifier (alias / package) is depth-invariant
 *  and returned unchanged; a relative one gets extra "../" per package segment.
 *  Caller contract: a relative moduleSpec must be relative to outDir root (as
 *  dbImport is). */
export function relativeModuleSpecifier(
  layout: OutputLayout,
  pkg: string | undefined,
  moduleSpec: string,
): string {
  if (layout === "flat") return moduleSpec;
  const isRelative = moduleSpec.startsWith("./") || moduleSpec.startsWith("../");
  if (!isRelative) return moduleSpec;
  const dir = packageToPath(pkg);
  const depth = dir === "" ? 0 : dir.split("/").length;
  if (depth === 0) return moduleSpec;
  const extra = "../".repeat(depth);
  return moduleSpec.startsWith("./") ? extra + moduleSpec.slice(2) : extra + moduleSpec;
}

/** A fully-resolved output destination. Import-identity belongs to the
 *  destination, not the generator. */
export interface ResolvedTarget {
  name: string;
  outDir: string;
  /** Package-specifier prefix others use to import modules produced here.
   *  Required only when another target imports from this one. */
  importBase: string | undefined;
  outputLayout: OutputLayout;
  dbImport: string;
  /**
   * Whether this target emits server runtime bindings. `true` (the default for
   * the implicit "default" target) = a full server package: Drizzle tables/views,
   * `runtime-ts` filter/sort allowlists, the whole DB layer. `false` = a
   * contract-only target: Zod schemas + inferred TS types ONLY, with no
   * `drizzle-orm` / `runtime-ts` import — for a shared wire-contract package
   * consumed by a UI/web client that has no database. The axis is the target's
   * AUDIENCE (server vs client), not any one artifact: in a contract target an
   * entity drops its `pgTable`, a projection drops its `pgView`, every object
   * renders as its plain shape. Allowlists are off here too (contract ⇒ no
   * `runtime-ts`); the finer `allowlists` knob only applies within a runtime target.
   */
  runtime: boolean;
}

/** importBase + (package path when package layout) + entity, extension-less. */
function crossTargetEntityPath(
  entityTarget: ResolvedTarget,
  entityPkg: string | undefined,
  entityName: string,
): string {
  const base = entityTarget.importBase;
  if (base === undefined) {
    throw new Error(
      `Cannot emit cross-target import: target "${entityTarget.name}" has no importBase. ` +
      `Set importBase on the target that holds the entity modules.`,
    );
  }
  const pkgPath = entityTarget.outputLayout === "package" ? packageToPath(entityPkg) : "";
  return pkgPath === "" ? `${base}/${entityName}` : `${base}/${pkgPath}/${entityName}`;
}

/** Specifier to import entity `entityName` (in `entityPkg`, produced into
 *  `entityTarget`) from a file emitted into `selfTarget`. Same target → relative
 *  (extStyle honored); cross target → extension-less importBase path. */
export function entityModuleSpecifier(
  selfTarget: ResolvedTarget,
  entityTarget: ResolvedTarget,
  entityPkg: string | undefined,
  entityName: string,
  extStyle: ExtStyle,
): string {
  if (selfTarget.name === entityTarget.name) {
    return crossEntitySpecifier(entityTarget.outputLayout, entityPkg, entityPkg, entityName, extStyle);
  }
  return crossTargetEntityPath(entityTarget, entityPkg, entityName);
}

/** A same-target sibling module (e.g. "<Entity>.columns"). Always relative,
 *  package-layout aware, extStyle honored. */
export function siblingSpecifier(
  selfTarget: ResolvedTarget,
  entityPkg: string | undefined,
  basename: string,
  extStyle: ExtStyle,
): string {
  return crossEntitySpecifier(selfTarget.outputLayout, entityPkg, entityPkg, basename, extStyle);
}

/** Barrel re-export specifier. Barrel sits at its target root, so same-target
 *  uses fromPkg=undefined (barrelEntrySpecifier); cross-target is the
 *  extension-less importBase path. */
export function barrelModuleSpecifier(
  selfTarget: ResolvedTarget,
  entityTarget: ResolvedTarget,
  entityPkg: string | undefined,
  entityName: string,
  extStyle: ExtStyle,
): string {
  if (selfTarget.name === entityTarget.name) {
    return barrelEntrySpecifier(entityTarget.outputLayout, entityPkg, entityName, extStyle);
  }
  return crossTargetEntityPath(entityTarget, entityPkg, entityName);
}

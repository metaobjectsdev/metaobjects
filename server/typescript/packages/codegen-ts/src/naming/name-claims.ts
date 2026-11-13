// The run's one claim registry (amending ADR-0044 and ADR-0056).
//
// Every name a generator emits into a shared scope is claimed here, at the point it is
// emitted: a module's exported type and collection names in the directory (and barrel) that
// holds them, a REST collection segment in the routes entry that serves it. The
// first claimant owns a name; a second claimant of the same name in the same scope is refused
// with ERR_NAME_COLLISION, naming both metadata nodes and the remedy. The same claimant
// claiming again is not a collision, and one name in two scopes is two names.
//
// A generator that is not wired claims nothing, and an object that emits nothing claims
// nothing, so the check follows the wiring by construction. An adopter's own generator can
// claim through `ctx.claim` too. A name is never rewritten to avoid a collision: a value
// object's type is its own name.
//

import { OBJECT_SUBTYPE_VALUE, collectionSegment, type MetaObject } from "@metaobjectsdev/metadata";
import type { GenContext } from "../generator.js";
import { collectionPascal } from "../naming.js";
import { emitsInstanceArtifacts } from "../instance-artifacts.js";
import { isTphSubtype } from "../tph.js";
import { packageToPath } from "../import-path.js";
import { effectivePackage } from "../docs-paths.js";

/** The error code a refused claim carries. Codegen-time and port-local (Java declares it on
 *  `OutputPackageCollisions`, Python on `name_claims`); not in the loader's shared error-code
 *  ledger. */
export const ERR_NAME_COLLISION = "ERR_NAME_COLLISION";

/** A claim: `scope` names where the name lives, `claimant` the metadata node (its
 *  `resolutionKey()`), `remedy` what the author can do about a collision. */
export type ClaimFn = (scope: string, name: string, claimant: string, remedy: string) => void;

/** The names one run's generators have emitted, by scope. One per `runGen`. */
export class NameClaims {
  private readonly owners = new Map<string, string>();

  claim(scope: string, name: string, claimant: string, remedy: string): void {
    const key = `${scope}\u0000${name}`;
    const existing = this.owners.get(key);
    if (existing === undefined) {
      this.owners.set(key, claimant);
      return;
    }
    if (existing === claimant) return;
    throw new Error(
      `${ERR_NAME_COLLISION}: "${existing}" and "${claimant}" both generate "${name}" in ${scope} — ${remedy}.`,
    );
  }
}

const FLAT_MODULE_REMEDY = 'rename one, or set outputLayout: "package" to place each object in the directory of its metadata package';
const PACKAGE_MODULE_REMEDY = "rename one";
const BARREL_REMEDY = "rename one, or drop the barrel and import each module by its path";
const COLLECTION_REMEDY_NOTE = "give one a distinct @collectionName";
const ROUTE_REMEDY = "rename one, give one a distinct @collectionName, or generate them with two routes entries mounted under different prefixes";

function layoutOf(ctx: GenContext): string {
  return ctx.config.outputLayout ?? "flat";
}

/** The scope of a module's exports: its target and, under the package layout, its package
 *  directory. Under the flat layout every module shares the target's one directory. */
function moduleScope(ctx: GenContext, obj: MetaObject): string {
  const dir = layoutOf(ctx) === "package" ? packageToPath(effectivePackage(obj)) : "";
  const target = ctx.renderContext?.selfTarget.name ?? "default";
  return `the module directory "${dir === "" ? "." : dir}" of target "${target}"`;
}

/** Whether `obj` exports a collection name: an object with instance artifacts (not abstract,
 *  backed by a store), never a value object. A TPH subtype does: it gets its own
 *  `list<Plural>`-style names against the shared base table. */
function hasCollection(obj: MetaObject): boolean {
  return obj.subType !== OBJECT_SUBTYPE_VALUE && emitsInstanceArtifacts(obj);
}

/**
 * Claim the names `obj`'s own modules export, in the directory that holds them: its type (and
 * every `<Name>`-prefixed export with it) and, for an object with a collection, its collection
 * name (`collectionPascal`, standing for the `list<Plural>` / `find<Plural>By...` exports and the
 * collection variable: a scope of its own, since no export is the bare plural). Called by the
 * entity and queries generators as they emit.
 */
export function claimModuleNames(ctx: GenContext, obj: MetaObject): void {
  if (ctx.claim === undefined) return;
  const remedy = layoutOf(ctx) === "package" ? PACKAGE_MODULE_REMEDY : FLAT_MODULE_REMEDY;
  const scope = moduleScope(ctx, obj);
  ctx.claim(scope, obj.name, obj.resolutionKey(), remedy);
  if (hasCollection(obj)) {
    ctx.claim(`the collection names of ${scope}`, collectionPascal(obj), obj.resolutionKey(), `${remedy}, or ${COLLECTION_REMEDY_NOTE}`);
  }
}

/** Claim, for the barrel at the target root, the name it re-exports from `obj`'s module. */
export function claimBarrelNames(ctx: GenContext, obj: MetaObject): void {
  if (ctx.claim === undefined) return;
  const target = ctx.renderContext?.selfTarget.name ?? "default";
  const scope = `the barrel (index.ts) of target "${target}"`;
  ctx.claim(scope, obj.name, obj.resolutionKey(), BARREL_REMEDY);
  if (hasCollection(obj)) ctx.claim(`the collection names of ${scope}`, collectionPascal(obj), obj.resolutionKey(), BARREL_REMEDY);
}

/** The REST collection segment an object is served under (`collectionSegment`). */
export function routeSegment(obj: MetaObject): string {
  return collectionSegment(obj);
}

/** Claim an object's REST collection segment in this routes entry. A TPH subtype is folded into
 *  its base's table and served under the base's route, so it claims none. */
export function claimRouteSegment(ctx: GenContext, obj: MetaObject): void {
  if (ctx.claim === undefined) return;
  if (!hasCollection(obj) || isTphSubtype(obj)) return;
  ctx.claim(
    `the REST collection segments of routes entry ${ctx.entryLabel ?? `"${ctx.config.outDir}"`}`,
    routeSegment(obj),
    obj.resolutionKey(),
    ROUTE_REMEDY,
  );
}

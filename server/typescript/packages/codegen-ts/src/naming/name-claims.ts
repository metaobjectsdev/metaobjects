// The run's one claim registry (ruling R52, amending ADR-0044 and ADR-0056).
//
// Every name a generator emits into a shared scope is claimed here, at the point it is
// emitted: a module's exported type and collection names in the directory (and barrel) that
// holds them, a REST collection segment in the routes entry that serves it. The first claimant
// owns a name; a second claimant of the same name in the same scope is refused with
// ERR_NAME_COLLISION, naming both metadata nodes and the remedy. The same claimant claiming
// again is not a collision, and one name in two scopes is two names.
//
// A generator that is not wired claims nothing, so the check follows the wiring by
// construction — the run-wide pre-pass (`collection-name-collision.ts`, retired) had to be told
// what was wired. An adopter's own generator can claim through `ctx.claim` too. A name is never
// rewritten to avoid a collision.

import {
  OBJECT_SUBTYPE_VALUE, OBJECT_ATTR_COLLECTION_NAME, OBJECT_ATTR_DB_SET_NAME, collectionNameOf, declaredCollectionName, toSnakeCase,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import type { GenContext } from "../generator.js";
import { packageToPath } from "../import-path.js";
import { effectivePackage } from "../docs-paths.js";
import { emitsInstanceArtifacts } from "../instance-artifacts.js";

/** The error code a refused claim carries. Codegen-time, port-local (C# declares the same
 *  value on `NameClaims`); not in the loader's shared error-code ledger. */
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

const MODULE_REMEDY =
  'rename one, or place the modules by package (outputLayout: "package")';
const BARREL_REMEDY =
  "rename one, or drop the barrel and import each module by its path";
const ROUTE_REMEDY =
  "rename one, or generate them with two routes entries mounted under different prefixes";

/** The scope of a module's exports: its target and, under the package layout, its package
 *  directory. Under the flat layout every module shares the target's one directory. */
function moduleScope(ctx: GenContext, obj: MetaObject): string {
  const layout = ctx.config.outputLayout ?? "flat";
  const dir = layout === "package" ? packageToPath(effectivePackage(obj)) : "";
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
 * Claim the names `obj`'s own modules export, in the directory that holds them: its type
 * (`<Name>`, and every `<Name>…`-prefixed export with it) and, for an object with a collection,
 * its collection name (`pluralize(name)`, standing for the `list<Plural>` / `find<Plural>By…`
 * exports and the collection variable — a scope of its own, since no export is the bare plural).
 * Called by the entity and queries generators as they emit.
 */
export function claimModuleNames(ctx: GenContext, obj: MetaObject): void {
  warnDeprecatedCollectionAlias(ctx, obj);
  if (ctx.claim === undefined) return;
  const scope = moduleScope(ctx, obj);
  ctx.claim(scope, obj.name, obj.resolutionKey(), MODULE_REMEDY);
  if (hasCollection(obj)) ctx.claim(`the collection names of ${scope}`, collectionNameOf(obj), obj.resolutionKey(), MODULE_REMEDY);
}

const warnedAliases = new WeakSet<MetaObject>();

/** rc.19 (R57): `@dbSetName` is a deprecated alias of `@collectionName` for one release. Once per object. */
function warnDeprecatedCollectionAlias(ctx: GenContext, obj: MetaObject): void {
  if (warnedAliases.has(obj) || declaredCollectionName(obj)?.deprecatedAlias !== true) return;
  warnedAliases.add(obj);
  ctx.warn(
    `${obj.resolutionKey()}: @${OBJECT_ATTR_DB_SET_NAME} is deprecated and will be removed in the next release; ` +
      `rename it to @${OBJECT_ATTR_COLLECTION_NAME} (same value — it names the collection in every port now).`,
  );
}

/** Claim, for the barrel at the target root, the names it re-exports from `obj`'s module. */
export function claimBarrelNames(ctx: GenContext, obj: MetaObject): void {
  if (ctx.claim === undefined) return;
  const target = ctx.renderContext?.selfTarget.name ?? "default";
  const scope = `the barrel (index.ts) of target "${target}"`;
  ctx.claim(scope, obj.name, obj.resolutionKey(), BARREL_REMEDY);
  if (hasCollection(obj)) ctx.claim(`the collection names of ${scope}`, collectionNameOf(obj), obj.resolutionKey(), BARREL_REMEDY);
}

/** The REST collection segment an object is served under: its name snake_cased, then
 *  pluralized (`entity-ui-descriptor.ts` `resourcePath`). */
export function routeSegment(obj: MetaObject): string {
  return toSnakeCase(collectionNameOf(obj));
}

/** Claim an object's REST collection segment in this routes entry. */
export function claimRouteSegment(ctx: GenContext, obj: MetaObject): void {
  if (ctx.claim === undefined) return;
  ctx.claim(
    `the REST collection segments of routes entry ${ctx.entryLabel ?? `"${ctx.config.outDir}"`}`,
    routeSegment(obj),
    obj.resolutionKey(),
    ROUTE_REMEDY,
  );
}

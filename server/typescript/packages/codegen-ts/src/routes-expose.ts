import type { MetaObject } from "@metaobjectsdev/metadata";

/**
 * The five CRUD verbs a generated routes file can mount.
 *
 * Mirrors `CrudVerb` in `@metaobjectsdev/runtime-ts` — both the fastify and hono mount
 * modules declare it identically. It is RESTATED rather than imported because codegen-ts
 * does not depend on runtime-ts: codegen emits a call to that helper, it never links
 * against it. Pinned against both runtime declarations by test/routes-expose.test.ts, so
 * the two cannot drift the way the cell-renderer keys drifted from the view registry.
 */
export const CRUD_VERBS = ["list", "get", "create", "update", "delete"] as const;

/**
 * The verbs a TPH discriminator BASE serves at its own path.
 *
 * Read-only BY CONSTRUCTION: the discriminated union has no single writable shape, so the
 * base mount can never carry `create`/`update`/`delete` — an author-supplied `expose`
 * INTERSECTS with this set rather than replacing it, and may narrow to just `list`.
 * Writes live on the per-subtype mounts at `<base path>/<segment>`.
 *
 * Named here because two places need it and a second literal would be a second answer:
 * `routes-file.ts` emits the mount, and `api-model.ts` documents it. They disagreed —
 * the api surface documented POST/PATCH/DELETE on a base path that serves none, under a
 * comment claiming the documented paths "match the generated routes exactly".
 */
export const TPH_POLYMORPHIC_VERBS = ["list", "get"] as const;
export type CrudVerb = (typeof CRUD_VERBS)[number];

/**
 * Which CRUD verbs a generated routes file mounts (#348).
 *
 * A `filter` cannot express this. `filter` decides whether the file emits AT ALL, per
 * entity, so it can only remove the whole surface; restricting to a SUBSET of verbs is a
 * different axis. That is why this is a generator option rather than the "narrow it with
 * `filter`" remedy that answered the retired `@emit*` attributes — the same reasoning that
 * made a TPH subtype's opt-IN grid `tphSubtypeGrids` rather than a filter.
 *
 * It is deliberately NOT metadata. Which verbs a deployment exposes is a property of the
 * app, not of the model: the same entity is read-only in one service and writable in
 * another, and an attribute would force one answer into the shared spine.
 *
 * Absent — or a function returning `undefined` for an entity — means all five, and emits
 * output byte-identical to before this option existed.
 */
export type ExposeOption =
  | readonly CrudVerb[]
  | ((entity: MetaObject) => readonly CrudVerb[] | undefined);

/** Resolve the option for one entity. `undefined` means "mount all five". */
export function resolveExpose(
  entity: MetaObject,
  expose: ExposeOption | undefined,
): readonly CrudVerb[] | undefined {
  if (expose === undefined) return undefined;
  return typeof expose === "function" ? expose(entity) : expose;
}

/**
 * Narrow a mount whose verb set is already fixed by construction.
 *
 * A TPH polymorphic mount is read-only (`["list", "get"]`) because the discriminated union
 * has no single writable shape. An author-supplied `expose` may narrow that further but
 * must never widen it, so this INTERSECTS rather than replaces: mounting `create` on a
 * surface that cannot serve it would emit a route that fails at runtime, and a wrong
 * endpoint is worse than a missing one.
 */
export function intersectExpose(
  fixed: readonly CrudVerb[],
  requested: readonly CrudVerb[] | undefined,
): readonly CrudVerb[] {
  if (requested === undefined) return fixed;
  const want = new Set<string>(requested);
  return fixed.filter((v) => want.has(v));
}

/**
 * The `expose: [...]` line for a mount call, or "" when every verb mounts.
 *
 * Emitting nothing rather than the full list keeps output byte-identical for every
 * project that does not use the option.
 */
export function exposeLine(verbs: readonly CrudVerb[] | undefined, indent: string): string {
  if (verbs === undefined) return "";
  return `\n${indent}expose: [${verbs.map((v) => JSON.stringify(v)).join(", ")}],`;
}

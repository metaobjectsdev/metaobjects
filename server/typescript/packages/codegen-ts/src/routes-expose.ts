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

/**
 * The auth-seam paragraph in a generated routes handler's JSDoc.
 *
 * Stock CRUD is unauthenticated, and until #367 the only thing a generated routes file
 * said about that was a header line pointing at `<Entity>.extra.ts` "(e.g., auth)" — a
 * sibling module nothing imports. An agent building a real API read it, went looking for
 * the seam, found none, and deleted `routesFile()` from its config rather than mount five
 * open endpoints over a password-hash table. The seam it needed already existed in both
 * frameworks; nothing told it where.
 *
 * Both recipes are gated by `runtime-ts/test/route-auth-seam.test.ts` against the real
 * mount helpers, because a recipe in generated output that does not work is the defect
 * this replaces, not a smaller version of it. Hono's trailing wildcard is load-bearing
 * and counter-intuitive: `"/users/*"` matches the collection path `/users` itself, so one
 * `app.use` covers list, get and every write.
 *
 * The closing sentence is the part an adopter most needs and no knob can supply: a
 * row-ownership rule ("only the owner may read this row") is not expressible in a mount,
 * so the honest move is to hand-write those verbs and narrow the generated file with
 * `expose` — not to mount them and hope.
 */
export function authSeamJsDoc(opts: {
  framework: "fastify" | "hono";
  /** The emitted handler's name, so the worked example is callable as written. */
  handlerName: string;
  /** Hono only: the source expression for this file's mount path, e.g. "`/api${User.$path}`". */
  mountPathExpr?: string;
  /** False for a read-only mount, which `expose` cannot narrow further. */
  narrowable: boolean;
}): string {
  const recipe =
    opts.framework === "fastify"
      ? ` *     app.register(async (s) => {\n` +
        ` *       s.addHook("preHandler", requireAuth);\n` +
        ` *       await ${opts.handlerName}(s);\n` +
        ` *     });`
      : ` *     app.use(${opts.mountPathExpr}, requireAuth);   // matches the collection path too\n` +
        ` *     ${opts.handlerName}(app, { db });`;
  const guarded =
    opts.framework === "fastify"
      ? `Register this inside a scope that\n` +
        ` * carries your hook and every verb below is guarded — routes outside that scope\n` +
        ` * are not:`
      : `Guard the mount path with\n` + ` * middleware before calling this:`;
  // Name the generator that actually emitted this file — `routesFile` does not exist in
  // a Hono project's config, and a recipe naming the wrong symbol is the same defect
  // one size smaller.
  const generatorName = opts.framework === "fastify" ? "routesFile" : "routesFileHono";
  const narrowNote = opts.narrowable
    ? `\n *\n * A row-ownership rule ("only the owner may read this row") is not expressible in a\n` +
      ` * mount. Hand-write those verbs and narrow this file with\n` +
      ` * ${generatorName}({ expose: ["list", "get"] }) rather than mounting them open.`
    : `\n *\n * A row-ownership rule ("only the owner may read this row") is not expressible in a\n` +
      ` * mount. Hand-write those reads rather than exposing this one open.`;
  return ` *\n * Auth: these endpoints are unauthenticated. ${guarded}\n *\n${recipe}${narrowNote}`;
}

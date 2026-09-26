// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/routes-hono.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { routesFileHono } from "./codegen/generators/routes-hono.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`.
// targets:       Hono + Drizzle. The emitted file calls `mountCrudRoutes` /
//                `mountReadOnlyCrudRoutes` and takes its persistence client as INJECTED DEPS
//                (`register<Entity>Routes(app, { db })`) rather than a module-singleton
//                import — which is what makes it portable to any host that can hand Hono a
//                request. If your framework is not Hono, THIS is the file to retarget: swap
//                the mount helper and the exported signature; the metadata walk is
//                framework-neutral and stays as-is.
// use-when:      you want generated Hono CRUD routes per entity.
// emits:         <target>/<Entity>.routes.hono.ts — full CRUD for write-through entities,
//                read-only (GET list + GET :id) for projections. Skipped for any sourceless
//                object and for TPH subtypes.
// owns:          ALL of it. The route COMPOSITION is below (`renderRoutesHono`), not a call
//                into the engine. And the emitted file does not import its mount helpers from
//                `@metaobjectsdev/runtime-ts`: `meta eject routes-hono` also copied their
//                SOURCE (the Hono adapter, filter parser, error envelopes, pagination) into
//                `codegen/runtime/`, and the emitted imports point there. Fix an adapter
//                defect in that copy; nothing waits on a release. `runtimeImport` moves the
//                copy (relative to the output root, like `dbImport`, or a path alias);
//                `runtimeImport: "@metaobjectsdev/runtime-ts"` goes back to the package.
//                `meta eject --list` reports whether each copied file still matches the
//                package it came from.
// customize:     this generator is YOURS — edit it freely. Decide per generator what you
//                consume: wire only the generators whose output you actually import, and
//                narrow this one with its `filter`. There is no `@emit*` metadata
//                attribute — those were never registered vocabulary, so `meta verify`
//                rejects them (ERR_UNKNOWN_ATTR).
// composes-with: entity.ts (imports the table/schemas/allowlists), queries.ts.
//
// The composition (`renderRoutesHono`) is the relocated body of the engine's
// `renderRoutesFileHono` — byte-identical output to start, now YOURS to change. It imports
// only public engine primitives.

// ts-poet combinators come from the engine package, NOT a bare "ts-poet" import: the Code
// fragments composed here must share ONE ts-poet instance with the engine's.
import { code, imp } from "@metaobjectsdev/codegen-ts";
import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  type RenderContext,
  resolveExpose,
  type ExposeOption,
  type CrudVerb,
  authSeamJsDoc,
  exposeLine,
  isTphSubtype,
  isProjection,
  isWriteThrough,
  servesReadApi,
  formatTs,
  renderRoutesIndex,
  routesIndexFileName,
  entityOutputPath,
  effectivePackage,
  entityModuleSpecifier,
  httpRuntimeSpecifier,
  ownedRuntimeImport,
  GENERATED_HEADER,
  GENERATED_EDIT_NOTE,
  sidecarLine,
} from "@metaobjectsdev/codegen-ts";

// --- composition (OWNED) — assembles one <Entity>.routes.hono.ts. Change this to change the output. ---
// Dispatch: a projection → mountReadOnlyCrudRoutes (GET list + GET :id); every other
// writable entity → mountCrudRoutes. `apiPrefix` is composed into the path string (Hono has
// no register-with-prefix primitive). TPH subtypes never reach here — see the filter below.

function renderRoutesHono(
  entity: MetaObject,
  ctx: RenderContext,
  // #348 — resolved by the generator from its `expose` option. undefined = all five verbs,
  // emitting no `expose` key at all, so output stays byte-identical without it.
  //
  // Applies to the CRUD mount only. The projection branch above uses
  // mountReadOnlyCrudRoutes, a different helper that is read-only by construction and
  // takes no `expose` — there is no writable surface there to narrow.
  expose?: readonly CrudVerb[],
): string {
  const entityName = entity.name;
  const handlerName = `register${entityName}Routes`;

  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    effectivePackage(entity),
    entityName,
    ctx.extStyle,
  );

  // Where the mount helpers come from: the package, or an owned copy (owned-runtime.ts).
  const runtimeSpec = httpRuntimeSpecifier("hono", ctx, effectivePackage(entity));

  const header =
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n${sidecarLine(`${entityName}.extra.ts`)}`;

  // Path composition: apiPrefix is a literal string in the URL.
  const pathExpr = ctx.apiPrefix
    ? `\`${ctx.apiPrefix}\${${entityName}.$path}\``
    : `${entityName}.$path`;
  // The same path with Hono's trailing wildcard, for the auth recipe in the JSDoc.
  // `"/users/*"` matches `/users` itself, so one app.use covers list, get and writes.
  const authPathExpr = ctx.apiPrefix
    ? `\`${ctx.apiPrefix}\${${entityName}.$path}/*\``
    : `\`\${${entityName}.$path}/*\``;

  // --- Projection path: read-only routes (GET list + GET :id) ---
  if (isProjection(entity)) {
    const camelName = entityName.charAt(0).toLowerCase() + entityName.slice(1);
    const HonoSym = imp("t:Hono@hono");
    const mountReadOnlyCrudRoutesSym = imp(`mountReadOnlyCrudRoutes@${runtimeSpec}`);

    const literalImports = code`
import {
  ${entityName},
  ${camelName}View,
  ${entityName}FilterAllowlist,
  ${entityName}SortAllowlist,
} from ${JSON.stringify(entityFileSpec)};
`;

    const body = code`
/**
 * Mount read-only REST endpoints for ${entityName} (projection — view-backed, no writes).
 *
 * Exposes GET list + GET :id only. POST/PATCH/DELETE return 405.
 * Customize: register this as-is, or import individual route helpers from
 * ${runtimeSpec}.
${authSeamJsDoc({ framework: "hono", handlerName, mountPathExpr: authPathExpr, narrowable: false })}
 */
// biome-ignore lint/suspicious/noExplicitAny: consumer-defined Hono bindings/variables
export function ${handlerName}(app: ${HonoSym}<any, any, any>, deps: { db: unknown }): void {
  ${mountReadOnlyCrudRoutesSym}({
    app,
    path: ${pathExpr},
    db: deps.db,
    view: ${camelName}View,
    filterAllowlist: ${entityName}FilterAllowlist,
    sortAllowlist: ${entityName}SortAllowlist,
    dialect: ${JSON.stringify(ctx.dialect)},
  });
}
`;

    return header + literalImports.toString() + body.toString();
  }

  // --- Vanilla / write-through entity path: full CRUD routes ---
  const tableVar = ctx.collectionName(entityName);

  // #214: a write-through entity reads through its replica view so derived origin.*
  // columns are present. Without this the Hono adapter returned rows missing every
  // derived field the generated type and Zod schema promise, and a filter or sort on
  // one — both ALLOWED by the generated allowlists — hit a column the table does not
  // have, producing a 500. Fastify has done this since #214; Hono was simply never
  // wired, exactly as it was never wired for #286's `.all()`/`.get()` fix.
  const writeThrough = isWriteThrough(entity);
  const camelName = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const readViewLine = writeThrough ? `\n    readView: ${camelName}View,` : "";
  const exposeLineHono = exposeLine(expose, "    ");

  const HonoSym = imp("t:Hono@hono");
  const mountCrudRoutesSym = imp(`mountCrudRoutes@${runtimeSpec}`);

  const literalImports = code`
import {
  ${entityName},
  ${tableVar},
  ${entityName}InsertSchema,
  ${entityName}UpdateSchema,
  ${entityName}FilterAllowlist,
  ${entityName}SortAllowlist,${writeThrough ? `\n  ${camelName}View,` : ""}
} from ${JSON.stringify(entityFileSpec)};
`;

  const body = code`
/**
 * Mount the 5 standard REST endpoints for ${entityName} using Drizzle directly.
 *
 * Customize: register this as-is for stock CRUD, OR import the per-verb
 * helpers (mountListRoute, mountGetRoute, ...) from
 * ${runtimeSpec} and mix with your own handlers
 * (auth, side effects, etc.).
${authSeamJsDoc({ framework: "hono", handlerName, mountPathExpr: authPathExpr, narrowable: true })}
 */
// biome-ignore lint/suspicious/noExplicitAny: consumer-defined Hono bindings/variables
export function ${handlerName}(app: ${HonoSym}<any, any, any>, deps: { db: unknown }): void {
  ${mountCrudRoutesSym}({
    app,
    path: ${pathExpr},
    db: deps.db,
    table: ${tableVar},${readViewLine}
    insertSchema: ${entityName}InsertSchema,
    updateSchema: ${entityName}UpdateSchema,
    filterAllowlist: ${entityName}FilterAllowlist,
    sortAllowlist: ${entityName}SortAllowlist,
    dialect: ${JSON.stringify(ctx.dialect)},${exposeLineHono}
  });
}
`;

  return header + literalImports.toString() + body.toString();
}

export interface RoutesFileHonoOpts {
  filter?: (entity: MetaObject) => boolean;
  /**
   * Which CRUD verbs the emitted file mounts (#348). Verbs, or a per-entity function;
   * absent means all five and emits byte-identical output.
   *
   *   routesFileHono({ expose: (e) => e.name === "AuditEntry" ? ["list", "get"] : undefined })
   *
   * A `filter` cannot express this — it decides whether the file emits AT ALL, so it can
   * only remove the whole surface, not restrict it to a subset of verbs.
   */
  expose?: ExposeOption;
  /**
   * Also emit `routes.index.hono.ts` at the target root: one `registerAllRoutes(...)` that registers every
   * entity this generator emitted a routes file for, so adding an entity needs no edit to
   * your host file. Off by default, so a project that does not ask gets no new file.
   */
  registerAll?: boolean;
  /**
   * Where the emitted routes import their mount helpers from. Absent: the adapter copy
   * `meta eject routes-hono` placed in `codegen/runtime/`, by a path computed from the
   * target's output directory. A relative value is relative to the output root (like
   * `dbImport`); `"@metaobjectsdev/runtime-ts"` imports the package instead.
   */
  runtimeImport?: string;
  target?: string;
}

export const routesFileHono = function routesFileHono(opts?: RoutesFileHonoOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  // Eligibility, minus the TPH question — stated ONCE so the emit set and the warn set
  // below cannot drift apart. They differ only by `!isTphSubtype` vs `isTphSubtype`, and
  // written out twice a later edit to one silently makes an entity either stop emitting
  // without being named as held back, or get warned about while still emitting.
  // (Same shape as tanstack's grid generator, which factors it the same way.)
  const passesOtherGates = (e: MetaObject): boolean =>
    servesReadApi(e) && userFilter(e);
  const generator: Generator = {
    name: "routes-file-hono",
    // Marks this as the Hono routes generator so the runner can aggregate
    // `ctx.config.includeHonoRoutes` and api-docs auto-documents the Hono surface.
    emitsHonoRoutes: true,
    // TPH subtypes are EXCLUDED, matching the Fastify generator. A TPH subtype shares
    // its base's table, so mounting vanilla CRUD for it produced routes with no
    // discriminator scoping at all: the list returned EVERY subtype's rows, and
    // get/patch/delete by id happily operated on rows belonging to a different
    // subtype. Silently wrong data, which is worse than no route. Fastify dispatches
    // these to a discriminator-aware renderer; the Hono runtime has no discriminator
    // support yet, so this fails CLOSED and the run says so (see the warning below)
    // rather than shipping an artifact that returns the wrong rows.
    filter: (e: MetaObject) => passesOtherGates(e) && !isTphSubtype(e),
    generate: async (ctx) => {
      // One note per run naming every TPH subtype held back, so the gap is visible at
      // `meta gen` time rather than discovered as missing endpoints in production.
      const skipped = ctx.entities.filter((e) => passesOtherGates(e) && isTphSubtype(e));
      if (skipped.length > 0) {
        const why =
          "the Hono adapter has no discriminator scoping yet, so per-subtype CRUD would " +
          "return and mutate OTHER subtypes' rows. Use routesFile() (Fastify), which " +
          "dispatches TPH correctly, or hand-write the scoped routes.";
        const names = skipped.map((e) => e.name).join(", ");
        ctx.warn(`no Hono routes emitted for the TPH subtype(s) ${names} — ${why}`);
      }
      const files = await emit(ctx);
      if (!opts?.registerAll) return files;
      const matched = ctx.entities.filter(ctx.matches);
      if (matched.length === 0 || !ctx.renderContext) return files;
      return [...files, {
        path: routesIndexFileName("hono"),
        content: await formatTs(renderRoutesIndex(matched, ctx.renderContext, "hono")),
      }];
    },
  };
  const emit = perEntity(async (entity, ctx) => {
    if (!ctx.renderContext) {
      throw new Error("routes-file-hono: renderContext is required (provided by runGen)");
    }
    const renderContext: RenderContext = {
      ...ctx.renderContext,
      httpRuntimeImport: opts?.runtimeImport
        ?? ownedRuntimeImport(ctx.projectRoot ?? ".", ctx.renderContext.selfTarget.outDir),
    };
    return {
      path: entityOutputPath(
        ctx.config.outputLayout ?? "flat",
        effectivePackage(entity),
        `${entity.name}.routes.hono.ts`,
      ),
      content: await formatTs(renderRoutesHono(entity, renderContext, resolveExpose(entity, opts?.expose))),
    };
  });
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<RoutesFileHonoOpts>;

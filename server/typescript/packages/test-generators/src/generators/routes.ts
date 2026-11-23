// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/routes.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { routesFile } from "./codegen/generators/routes.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Fastify + Drizzle. The emitted file calls `mountCrudRoutes` /
//                `mountReadOnlyCrudRoutes` / `mountM2mRoute` and binds a module-singleton
//                `db`. Its copied ../templates/routes-file.ts is the file to retarget for
//                another HTTP framework; see also the routes-hono template, whose
//                deps-injected shape ports more easily to hosts that hand you a request.
// use-when:      you want generated Fastify REST routes per entity. Drop it and hand-write routes
//                if you need bespoke endpoints — or keep it and register extra handlers YOURSELF
//                alongside the generated `register<Entity>Routes(app)` call. Nothing here
//                discovers a sibling module: a `<Entity>.extra.ts` next to the output is a naming
//                convention, not a plugin point, so its handlers only mount if your server calls them.
// emits:         <target>/<Entity>.routes.ts — full CRUD for write-through entities, read-only
//                (GET list + GET :id) for projections (GET list alone for a keyless one or a report), polymorphic + per-subtype for TPH bases.
//                Skipped for any sourceless object (incl. every object.value, source-less by
//                value purity) and for TPH subtypes — no source.rdb means no table/allowlist
//                for a routes file to import (#248 R2).
// owns:          ALL of it. The route COMPOSITION (CRUD, read-only projections, M:N traversal,
//                TPH per-subtype route sets) is `writeRoutesFile` in ../templates/routes-file.ts,
//                which `meta eject routes` copied beside this file — edit it there to change
//                what is emitted. And the emitted file does not import
//                its mount helpers from `@metaobjectsdev/runtime-ts`: `meta eject routes` also
//                copied their SOURCE (the Drizzle/Fastify adapter, filter parser, error
//                envelopes, pagination) into `codegen/runtime/`, and the emitted imports point
//                there. Fix an adapter defect in that copy; nothing waits on a release.
//                `runtimeImport` moves the copy (relative to the output root, like `dbImport`,
//                or a path alias); `runtimeImport: "@metaobjectsdev/runtime-ts"` goes back to
//                the package. `meta eject --list` reports whether each copied file still
//                matches the package it came from.
// customize:     this generator (filter, output path, target) is YOURS — edit it freely.
//                Decide per generator what you consume: wire only the generators whose
//                output you actually import, and narrow this one with its `filter`. There
//                is no `@emit*` metadata attribute — those were never registered
//                vocabulary, so `meta verify` rejects them (ERR_UNKNOWN_ATTR). For per-verb
//                control, import the mount* helpers from your copy in `codegen/runtime/` and
//                mix them with your own handlers (auth, side effects).
// composes-with: entity.ts (imports the table/schemas/allowlists), queries.ts.

import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  type RenderContext,
  resolveExpose,
  type ExposeOption,
  servesReadApi,
  DEFAULT_OUTPUT_LAYOUT,
  entityOutputPath,
  effectivePackage,
  ownedRuntimeImport,
  isTphSubtype,
  claimRouteSegment,
} from "@metaobjectsdev/codegen-ts/engine";
import { renderRoutesFile } from "../templates/routes-file.js";
import { renderRoutesIndex, routesIndexFileName } from "../templates/routes-index.js";

export interface RoutesFileOpts {
  filter?: (entity: MetaObject) => boolean;
  /**
   * Which CRUD verbs the emitted file mounts (#348). Verbs, or a per-entity function;
   * absent means all five and emits byte-identical output.
   *
   *   routesFile({ expose: (e) => e.name === "AuditEntry" ? ["list", "get"] : undefined })
   *
   * A `filter` cannot express this — it decides whether the file emits AT ALL, so it can
   * only remove the whole surface, not restrict it to a subset of verbs.
   */
  expose?: ExposeOption;
  /**
   * Also emit `routes.index.ts` at the target root: one `registerAllRoutes(...)` that registers every
   * entity this generator emitted a routes file for, so adding an entity needs no edit to
   * your host file. Off by default, so a project that does not ask gets no new file.
   */
  registerAll?: boolean;
  /**
   * The row cap of a report list route (default 10000, the same in every port). With no
   * `limit` a report answers every row up to the cap and is refused above it with
   * `400 { "error": "report_too_large", "maxRows": N }`; an explicit `limit` above it is
   * refused the same way. Absent emits no key, so the output stays byte-identical.
   */
  reportMaxRows?: number;
  /**
   * Where the emitted routes import their mount helpers from. Absent: the adapter copy
   * `meta eject routes` placed in `codegen/runtime/`, by a path computed from the target's
   * output directory. A relative value is relative to the output root (like `dbImport`);
   * `"@metaobjectsdev/runtime-ts"` imports the package instead.
   */
  runtimeImport?: string;
  target?: string;
}

export const routesFile = function routesFile(opts?: RoutesFileOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const emitEntities = perEntity(async (entity, ctx) => {
    if (!ctx.renderContext) {
      throw new Error("routes-file: renderContext is required (provided by runGen)");
    }
    claimRouteSegment(ctx, entity);
    const renderContext: RenderContext = {
      ...ctx.renderContext,
      httpRuntimeImport: opts?.runtimeImport
        ?? ownedRuntimeImport(ctx.projectRoot ?? ".", ctx.renderContext.selfTarget.outDir),
    };
    return {
      path: entityOutputPath(ctx.config.outputLayout ?? DEFAULT_OUTPUT_LAYOUT, effectivePackage(entity), `${entity.name}.routes.ts`),
      content: renderRoutesFile(entity, renderContext, resolveExpose(entity, opts?.expose), opts?.reportMaxRows),
    };
  });
  const generator: Generator = {
    name: "routes-file",
    // Read by the api reference (`apiDocsFile()`): it lists the verbs this file mounts, so an
    // `expose` you pass here is honoured there. Keep this line if you change what the file mounts.
    mountsRoutes: {
      ...(opts?.expose !== undefined && { expose: opts.expose }),
      ...(opts?.filter !== undefined && { filter: opts.filter }),
    },
    // TPH subtypes get no standalone routes file (their routes live in the discriminator
    // base's); AND-composed with your filter.
    // #248 R2: an object with no declared/inherited source.rdb (of ANY kind) isn't
    // backed by any store — routes against it would import Drizzle table/allowlist
    // exports the entity file never emits. Gated by servesReadApi, which also skips
    // abstract objects: an abstract level has no table of its own to mount.
    filter: (e: MetaObject) =>
      servesReadApi(e) && !isTphSubtype(e) && userFilter(e),
    generate: async (ctx) => {
      const files = await emitEntities(ctx);
      if (!opts?.registerAll) return files;
      const matched = ctx.entities.filter(ctx.matches);
      if (matched.length === 0 || !ctx.renderContext) return files;
      return [...files, {
        path: routesIndexFileName("fastify"),
        content: renderRoutesIndex(matched, ctx.renderContext, "fastify"),
      }];
    },
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<RoutesFileOpts>;

// Hono route template — emits a per-entity routes file that delegates
// CRUD verbs to helpers from @metaobjectsdev/runtime-ts/hono.
//
// Hono parallel of templates/routes-file.ts. Two emit-shape differences
// vs the Fastify flavor, both reflecting Hono idioms rather than contract
// drift:
//
//   1) Exported function shape — `registerXxxRoutes(app, deps)` instead of
//      `xxxRoutes(fastify)`. Workers/Bun consumers typically pass `db`
//      through a per-request deps object (so a Worker can attach the
//      D1 client pulled off bindings) rather than reaching for a
//      module-level singleton. The Fastify flavor uses `import { db }`
//      because Fastify apps are long-lived Node processes where a
//      singleton is the norm. Both flavors talk to mountCrudRoutes /
//      mountReadOnlyCrudRoutes with identical wire behavior.
//
//   2) apiPrefix is composed into the resource path (`${apiPrefix}${path}`)
//      rather than wrapping the registration. Hono has no fastify.register
//      / prefix-wrapping primitive; sub-apps via `app.route(prefix, sub)`
//      exist but bloat the generated code. String concat is simpler and
//      produces identical URL grammar.
//
// Dispatch logic mirrors Fastify:
//   isProjection(entity)              → mountReadOnlyCrudRoutes (GET list + GET :id)
//   vanilla / write-through entity    → mountCrudRoutes (all 5 CRUD verbs)

import { code, imp } from "ts-poet";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { type RenderContext } from "../render-context.js";
import { entityModuleSpecifier } from "../import-path.js";
import { GENERATED_HEADER } from "../constants.js";
import { isProjection } from "../projection/projection-detector.js";

export function renderRoutesFileHono(entity: MetaObject, ctx: RenderContext): string {
  const entityName = entity.name;
  const handlerName = `register${entityName}Routes`;

  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    entity.package,
    entityName,
    ctx.extStyle,
  );

  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n` +
    `// Customize via ${entityName}.extra.ts in this directory (e.g., auth, additional handlers).\n`;

  // Path composition: apiPrefix is a literal string in the URL.
  const pathExpr = ctx.apiPrefix
    ? `\`${ctx.apiPrefix}\${${entityName}.$path}\``
    : `${entityName}.$path`;

  // --- Projection path: read-only routes (GET list + GET :id) ---
  if (isProjection(entity)) {
    const camelName = entityName.charAt(0).toLowerCase() + entityName.slice(1);
    const HonoSym = imp("t:Hono@hono");
    const mountReadOnlyCrudRoutesSym = imp(
      "mountReadOnlyCrudRoutes@@metaobjectsdev/runtime-ts/hono",
    );

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
 * @metaobjectsdev/runtime-ts/hono.
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

  const HonoSym = imp("t:Hono@hono");
  const mountCrudRoutesSym = imp("mountCrudRoutes@@metaobjectsdev/runtime-ts/hono");

  const literalImports = code`
import {
  ${entityName},
  ${tableVar},
  ${entityName}InsertSchema,
  ${entityName}UpdateSchema,
  ${entityName}FilterAllowlist,
  ${entityName}SortAllowlist,
} from ${JSON.stringify(entityFileSpec)};
`;

  const body = code`
/**
 * Mount the 5 standard REST endpoints for ${entityName} using Drizzle directly.
 *
 * Customize: register this as-is for stock CRUD, OR import the per-verb
 * helpers (mountListRoute, mountGetRoute, ...) from
 * @metaobjectsdev/runtime-ts/hono and mix with your own handlers
 * (auth, side effects, etc.).
 */
// biome-ignore lint/suspicious/noExplicitAny: consumer-defined Hono bindings/variables
export function ${handlerName}(app: ${HonoSym}<any, any, any>, deps: { db: unknown }): void {
  ${mountCrudRoutesSym}({
    app,
    path: ${pathExpr},
    db: deps.db,
    table: ${tableVar},
    insertSchema: ${entityName}InsertSchema,
    updateSchema: ${entityName}UpdateSchema,
    filterAllowlist: ${entityName}FilterAllowlist,
    sortAllowlist: ${entityName}SortAllowlist,
    dialect: ${JSON.stringify(ctx.dialect)},
  });
}
`;

  return header + literalImports.toString() + body.toString();
}

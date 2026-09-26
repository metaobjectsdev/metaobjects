// The aggregate route registration: ONE module that registers every generated entity's
// routes, so adding an entity to the model does not also mean editing the host file.
//
// Opt-in (`routesFile({ registerAll: true })` / `routesFileHono({ registerAll: true })`):
// a project that does not ask for it gets no new file, so `meta verify --codegen` does not
// start reporting a missing one after an upgrade.
//
// The handler names come from the same derivations the per-entity renderers use
// (`routesHandlerName` for Fastify, `register<Entity>Routes` for Hono), so a rename there
// breaks this file's imports at compile time instead of drifting silently.
import type { MetaObject } from "@metaobjectsdev/metadata";
import { GENERATED_HEADER, GENERATED_EDIT_NOTE } from "../constants.js";
import { effectivePackage } from "../docs-paths.js";
import { barrelEntrySpecifier } from "../import-path.js";
import { routesHandlerName } from "../naming.js";
import type { RenderContext } from "../render-context.js";

/** Which route flavor the index registers. */
export type RoutesIndexFlavor = "fastify" | "hono";

/** File name of the aggregate module, at the target root. */
export function routesIndexFileName(flavor: RoutesIndexFlavor): string {
  return flavor === "hono" ? "routes.index.hono.ts" : "routes.index.ts";
}

/**
 * Render the aggregate route module for `entities` — exactly the entities the routes
 * generator emitted a file for (the caller passes its own matched set). Entities are
 * registered in name order so the output is stable whatever order the model loads in.
 */
export function renderRoutesIndex(
  entities: readonly MetaObject[],
  ctx: RenderContext,
  flavor: RoutesIndexFlavor,
): string {
  const sorted = [...entities].sort((a, b) => a.name.localeCompare(b.name));
  const suffix = flavor === "hono" ? ".routes.hono" : ".routes";
  const handler = (e: MetaObject): string =>
    flavor === "hono" ? `register${e.name}Routes` : routesHandlerName(e.name);
  const imports = sorted.map((e) => {
    const spec = barrelEntrySpecifier(ctx.outputLayout, effectivePackage(e), `${e.name}${suffix}`, ctx.extStyle);
    return `import { ${handler(e)} } from ${JSON.stringify(spec)};`;
  });

  const lines: string[] = [`// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`];
  if (flavor === "hono") {
    lines.push(
      `import type { Hono } from "hono";`,
      ...imports,
      "",
      "/**",
      " * Register every generated entity's routes on `app`.",
      " *",
      " * Auth: every endpoint registered here is unauthenticated. Guard them with middleware",
      " * on the mount paths before calling this. An entity that needs a row-ownership rule",
      " * should not be registered open: narrow its routes with `expose` or hand-write them.",
      " */",
      "// biome-ignore lint/suspicious/noExplicitAny: consumer-defined Hono bindings/variables",
      "export function registerAllRoutes(app: Hono<any, any, any>, deps: { db: unknown }): void {",
      ...sorted.map((e) => `  ${handler(e)}(app, deps);`),
      "}",
    );
  } else {
    lines.push(
      `import type { FastifyInstance } from "fastify";`,
      ...imports,
      "",
      "/**",
      " * Register every generated entity's routes on `fastify`.",
      " *",
      " * Auth: every endpoint registered here is unauthenticated. Register this inside a",
      " * scope that carries your hook to guard all of them at once. An entity that needs a",
      " * row-ownership rule should not be registered open: narrow its routes with `expose`",
      " * or hand-write them.",
      " */",
      "export async function registerAllRoutes(fastify: FastifyInstance): Promise<void> {",
      ...sorted.map((e) => `  await ${handler(e)}(fastify);`),
      "}",
    );
  }
  return `${lines.join("\n")}\n`;
}

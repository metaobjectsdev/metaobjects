// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/openapi.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { openApiFile } from "./codegen/generators/openapi.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       OpenAPI 3.1. The document imports nothing: openapi-generator, Kiota, orval, oasdiff
//                and every other OpenAPI tool read it as they read a hand-written one.
// use-when:      a consumer of this API works from an OpenAPI document, or you want a change to the
//                API to show as a diff (docs/features/contract-emitters.md has the oasdiff recipe).
// emits:         <target>/openapi.json: every route of the REST contract the model serves, with the
//                filter, sort and paging parameters, the error envelope, and the model's wire
//                shapes as components.
// customize:     which objects it covers (`documentObjects`, narrowed by the `filter` option) and
//                where the file lands (the `path` option). Copied beside it, so yours too:
//                `buildOpenApiDocument`, which decides which operations exist and what each one
//                answers. If your API has routes of its own, that is the file to change.
// composes-with: contract-schema, whose canonical schemas are these components. Reads what the
//                routes generators declare (`expose`, `filter`), so a verb a project does not mount
//                is not in the document. For a project whose routes another port generates, pass
//                `expose` here, because this run cannot see them.
//
// `title`, `version`, `servers`, `securitySchemes` and `security` are options and not metadata:
// they are facts about a deployment and an application, and the model is shared across both.
//
// Everything below imports the engine from `@metaobjectsdev/codegen-ts` and the contract stages from
// `../contract/`. `meta eject` copies those modules into your project, under `codegen/templates/`,
// and your copy of this file imports them from there: they are yours too.
//
// The document never depends on the run. It covers the whole model, narrowed by this generator's
// `filter` and the project's `scope`, so `meta gen Author` writes the same bytes as a full run.

import { generatableObjects, type ExposeOption, type GenContext, type Generator } from "@metaobjectsdev/codegen-ts/engine";
import { buildOpenApiDocument, type OpenApiDocumentOptions } from "../contract/build-openapi.js";
import { contractObjects } from "../contract/object-schema.js";
import type { MetaObject } from "@metaobjectsdev/metadata";

/** The generator's stable name. */
const GENERATOR_NAME = "openapi";

const DEFAULT_PATH = "openapi.json";

export interface OpenApiFileOptions extends OpenApiDocumentOptions {
  /** Output path relative to the target's outDir. Default: `openapi.json`. */
  readonly path?: string;
  /**
   * The verbs your routes mount, for a project whose routes this run does not generate (a port
   * other than TypeScript). Default: what the routes generators in this run declare, else all of them.
   */
  readonly expose?: ExposeOption;
  /** Narrow which objects the document covers. An object a kept one references stays as a component. */
  readonly filter?: (obj: MetaObject) => boolean;
  /** Named output target: the file lands under its outDir. */
  readonly target?: string;
}

function documentObjects(ctx: GenContext): MetaObject[] {
  const root = ctx.loadedRoot;
  // A served report is its read model here, as it is in `ctx.entities`.
  const inScope = generatableObjects(root.objects(), root).filter((o) => (ctx.select?.(o.resolutionKey()) ?? true) && ctx.matches(o));
  return contractObjects(inScope, root);
}

/** One OpenAPI 3.1 document for the whole model. */
export function openApiFile(options: OpenApiFileOptions = {}): Generator {
  const { path, expose, filter, target, ...document } = options;
  const generator: Generator = {
    name: GENERATOR_NAME,
    generate: (ctx) => {
      const declared = ctx.config.routesExpose;
      const surface = expose ?? declared?.rest ?? declared?.restHono;
      const mounted = declared?.restMounted ?? declared?.restHonoMounted;
      const doc = buildOpenApiDocument({
        ...document,
        root: ctx.loadedRoot,
        objects: documentObjects(ctx),
        apiPrefix: ctx.renderContext?.apiPrefix ?? "",
        relationMap: ctx.renderContext?.relationMap ?? new Map(),
        reportExport: ctx.config.includeReportExport ?? false,
        ...(surface !== undefined && { expose: surface }),
        ...(mounted !== undefined && { mounted }),
      });
      return [{ path: path ?? DEFAULT_PATH, content: `${JSON.stringify(doc, null, 2)}\n` }];
    },
  };
  if (filter !== undefined) generator.filter = filter;
  if (target !== undefined) generator.target = target;
  return generator;
}

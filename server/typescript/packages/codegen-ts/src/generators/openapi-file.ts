// FR-022 — openApiFile(), the openapi reference generator: one OpenAPI 3.1 document for the generated
// REST surface. The document is built in src/contract/build-openapi.ts; this file decides which
// objects it covers, where it lands and which routes the run mounts.
//
// The document never depends on the run. It covers the whole model, narrowed by this generator's
// `filter` and the project's `scope`, so `meta gen Author` writes the same bytes as a full run.

import type { GenContext, Generator } from "../generator.js";
import { buildOpenApiDocument, type OpenApiDocumentOptions } from "../contract/build-openapi.js";
import { contractObjects } from "../contract/object-schema.js";
import type { ExposeOption } from "../routes-expose.js";
import { generatableObjects } from "../source-detect.js";
import type { MetaObject } from "@metaobjectsdev/metadata";

/** The generator's stable name. */
const GENERATOR_NAME = "openapi";

const DOCUMENT_PATH = "openapi.json";

export interface OpenApiFileOptions extends OpenApiDocumentOptions {
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
  const { expose, filter, target, ...document } = options;
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
        reportExport: ctx.config.reportExportInRun ?? false,
        ...(surface !== undefined && { expose: surface }),
        ...(mounted !== undefined && { mounted }),
      });
      return [{ path: DOCUMENT_PATH, content: `${JSON.stringify(doc, null, 2)}\n` }];
    },
  };
  if (filter !== undefined) generator.filter = filter;
  if (target !== undefined) generator.target = target;
  return generator;
}

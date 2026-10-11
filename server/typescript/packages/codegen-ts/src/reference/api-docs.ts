// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/api-docs.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { apiDocsFile } from "./codegen/generators/api-docs.js";
//
// RUNTIME: this file executes under whatever runs `meta docs`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Markdown. The pages describe the code the stock TypeScript generators
//                emit (the entity module, queries, the Fastify routes and, when
//                `routesFileHono` is wired, the Hono ones, the prompt and output helpers);
//                they import nothing.
// use-when:      you want to change the API reference `meta docs` writes: which units get
//                a page, where the pages land, or which of the three forms are written.
//                `meta docs` writes these pages without this file; eject it only to change
//                them. If your generators emit a different API than the stock ones, the
//                reference is wrong for you until you change what is written here.
// emits:         under `docs.outDir`, in the api surface's directory (`api/` by default):
//                README.md, the index; AGENT-API.md, the condensed form the agent context
//                points at; <Node>.md per unit (an entity, a projection, a served report,
//                a template). Under `outputLayout: "package"` the unit pages fold under
//                their package path.
// customize:     which units get a page (`model.units` in `generate`), where a page lands
//                (`docPageOutputPath` under `apiDir`) and which forms are written (the
//                index and the agent form are the two `unshift`ed files). Stays in the
//                package: `buildApiModelForRun`, which reads the model and the run into
//                the description of the generated API, and `renderEntityApiPage` /
//                `renderApiIndex` / `renderAgentApi`, which write it. The always-on agent context names
//                `api/AGENT-API.md`; if you move or drop that file, the pointer is the
//                other half.
// composes-with: docs (each api page links back to its model page when `meta docs` writes
//                the model surface too) and the routes generators (the Hono routes are
//                documented when one is wired).
//
// HOW IT RUNS. `meta docs` runs it, so it is listed in the docs block of
// metaobjects.config.ts, not among the generators `meta gen` runs:
//   docs: { generators: [apiDocsFile()] }
// The `docsSurface` marker below says which surface it takes over: with it listed,
// `meta docs` and `meta verify --docs` run THIS generator for the api surface in place of
// the packaged one. Documentation has one door, so `meta gen` never runs it.
//
// Everything below imports ONLY from `@metaobjectsdev/codegen-ts` (the stable engine).

import {
  assertNoDuplicateDocPaths,
  buildApiModelForRun,
  docPageOutputPath,
  projectProvider,
  renderAgentApi,
  renderApiIndex,
  renderEntityApiPage,
  surfaceCrossHref,
  type DocPageNode,
  type DocPagePlacement,
  type EmittedFile,
  type Generator,
} from "@metaobjectsdev/codegen-ts";

// Where the pages go when nothing says otherwise. `meta docs` always says: it passes the
// directory of the api surface it is writing (`docs.apiSurfaces[].subDir`, default `api`).
const DEFAULT_API_DIR = "docs/api";

export function apiDocsFile(): Generator {
  return {
    name: "api-docs",
    // The surface this generator takes over when it is listed in `docs.generators`.
    docsSurface: "api",
    generate(ctx) {
      const provider = projectProvider(ctx.projectRoot ?? process.cwd());
      const layout = ctx.config.outputLayout ?? "flat";

      // What `meta docs` reports about the run: the directory of this surface, and whether
      // the model pages are written too.
      const apiDir = ctx.docsDoor?.apiSubDir ?? DEFAULT_API_DIR;
      const modelSurface = ctx.docsDoor?.modelSurface;
      const indexFilename = `${apiDir}/README.md`;
      const agentFilename = `${apiDir}/AGENT-API.md`;

      // One model of the generated API feeds every form. `buildApiModelForRun` reads what it
      // needs off the run: the layout, whether a Hono routes generator is wired (its routes
      // are documented exactly then), the project's `apiPrefix` and the primary keys.
      const model = buildApiModelForRun(ctx);

      // Every (path, node) placed, so a collision is refused after all pages are placed.
      const placements: DocPagePlacement[] = [];

      // OWNED: which units get a page, and where it lands.
      const files: EmittedFile[] = model.units.map((unit) => {
        const node: DocPageNode = { name: unit.node, package: unit.package };
        const path = `${apiDir}/${docPageOutputPath(layout, node)}`;
        placements.push({ path, fqn: unit.package ? `${unit.package}::${unit.node}` : unit.node });
        // The model page sits at the docs root at the same placement, so the link back is
        // derived from it and resolves in both layouts. None when the model surface is off.
        const modelPageHref = modelSurface
          ? surfaceCrossHref(path, docPageOutputPath(layout, node))
          : undefined;
        return { path, content: renderEntityApiPage(unit, provider, modelPageHref) };
      });

      // OWNED: the index and the agent form, first, and only when a unit page exists.
      if (files.length > 0) {
        placements.push({ path: indexFilename, fqn: "<the api-docs index page>" });
        placements.push({ path: agentFilename, fqn: "<the api-docs agent form>" });
        files.unshift(
          { path: indexFilename, content: renderApiIndex(model, layout, provider) },
          { path: agentFilename, content: renderAgentApi(model, provider) },
        );
      }

      // Two units that resolve to one output path are refused, naming both and the path,
      // instead of one page silently overwriting the other.
      assertNoDuplicateDocPaths(placements);

      return files;
    },
  };
}

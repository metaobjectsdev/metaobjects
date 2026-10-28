// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/api-docs.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { apiDocsFile } from "./codegen/generators/api-docs.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Markdown. The pages describe the code the stock TypeScript generators
//                emit (the entity module, queries, the Fastify routes and, when
//                `routesFileHono` is wired, the Hono ones, the prompt and output helpers);
//                they import nothing. The entity module, the queries and the routes are
//                described only when a generator in the run writes them
//                (`emitsEntityModule`, `emitsQueries`, `mountsRoutes`, or a copy of the
//                stock one by name); a generator of your own that writes them under
//                another name needs the marker, or its surface is left out.
// use-when:      you want to change the API reference: which units get a page, where the
//                pages land, or which of the three forms are written. The packaged
//                `apiDocsFile()` writes these pages without this file; eject it only to
//                change them. If your generators emit a different API than the stock ones,
//                the reference is wrong for you until you change what is written here.
// emits:         into the `docs` target, under `subDir` (`api/` by default): README.md, the
//                index; AGENT-API.md, the condensed form the agent context points at;
//                <Node>.md per unit (an entity, a projection, a served report, a template).
//                Under `outputLayout: "package"` the unit pages fold under their package
//                path.
// customize:     which units get a page (`model.units` in `generate`), where a page lands
//                (`docPageOutputPath` under `apiDir`) and which forms are written (the
//                index and the agent form are the two `unshift`ed files). Copied beside
//                it, so yours too: `buildApiModelForRun`, which reads the model and the run
//                into the description of the generated API, and `renderEntityApiPage` /
//                `renderApiIndex` / `renderAgentApi`, which write it. The always-on agent context names
//                `api/AGENT-API.md`; if you move or drop that file, the pointer is the
//                other half.
// composes-with: docs (each api page links back to its model page when `docsFile()` writes
//                to the same target, or to `modelBaseUrl`) and the routes generators (the
//                Hono routes are documented when one is wired).
//
// HOW IT RUNS. Like every generator: list it in `generators` in metaobjects.config.ts, with
// a `docs` target declared, and `meta gen` writes the pages (`meta verify --codegen` checks
// them). The `emitsApiDocs` marker tells the model pages in the same target where these are.
//
// Everything below imports the engine from `@metaobjectsdev/codegen-ts` (the generator base, the
// model walks, the naming tables) and the code that writes the pages from `../generators/`.
// `meta eject` copies those modules into your project, under `codegen/templates/`, and your
// copy of this file imports them from there: they are yours too.

import {
  assertNoDuplicateDocPaths,
  docPageOutputPath,
  projectProvider,
  surfaceCrossHref,
  type DocPageNode,
  type DocPagePlacement,
  type EmittedFile,
  type Generator,
  docsTemplateRoot,
  DOCS_TARGET_NAME,
} from "@metaobjectsdev/codegen-ts/engine";
import {
  renderAgentApi,
  renderApiIndex,
  renderEntityApiPage,
} from "../generators/api-doc-render.js";
import { buildApiModelForRun } from "../generators/api-model.js";

// Where the pages go, under the target, when `subDir` does not say.
const DEFAULT_API_DIR = "api";

export interface ApiDocsFileOpts {
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
  /** Output prefix under the target. Default `api`. */
  subDir?: string;
  /** Where the model pages are hosted when they are not written beside these. */
  modelBaseUrl?: string;
  /** Whether each page links back to its model page beside it. Default: whether
   *  `docsFile()` writes to the same target in this run. */
  modelSurface?: boolean;
}

export function apiDocsFile(opts?: ApiDocsFileOpts): Generator {
  const apiDir = (opts?.subDir ?? DEFAULT_API_DIR).replace(/\/$/, "");
  return {
    name: "api-docs",
    target: opts?.target ?? DOCS_TARGET_NAME,
    // Tells the model pages in the same target where these pages are.
    emitsApiDocs: { subDir: apiDir },
    generate(ctx) {
      const provider = projectProvider(docsTemplateRoot(ctx));
      const layout = ctx.config.outputLayout ?? "flat";

      // Whether each page links back to its model page: hosted elsewhere (`modelBaseUrl`),
      // or written to this same target by `docsFile()`, which the runner reports.
      const modelBaseUrl = opts?.modelBaseUrl?.replace(/\/$/, "");
      const modelSurface = opts?.modelSurface ?? ctx.docs?.modelPages ?? false;
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
        // derived from it and resolves in both layouts. None when there is no model page.
        const modelPageHref = modelBaseUrl !== undefined && modelBaseUrl !== ""
          ? `${modelBaseUrl}/${docPageOutputPath(layout, node)}`
          : modelSurface
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

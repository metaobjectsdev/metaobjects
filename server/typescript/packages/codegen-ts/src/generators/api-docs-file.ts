// apiDocsFile() — the `api-docs` GENERATOR (ADR-0022 Part 3, Tier-1 NATIVE).
//
// It documents the PUBLIC API surface the OTHER generators emit for a model —
// the generated code's own API, in two forms (a human reference + a condensed
// agent form). It is a thin wiring layer: it REUSES, without re-derivation,
//   • Task-1's buildApiModel() — the accurate-by-construction IR, and
//   • Task-2's renderEntityApiPage / renderApiIndex / renderAgentApi renderers,
//   • the shared docs-paths placement (collision-safe, layout-aware) that
//     docsFile() uses — so multi-package models never silently overwrite a page.
//
// Output (all under `docs/api/`):
//   • one `<Node>.md` per entity + template.output unit (the human page),
//   • `README.md` — the consolidated human index (GitHub treats it as landing),
//   • `AGENT-API.md` — the token-frugal agent form.
//
// Unlike `docs`/`mermaid-er` (Tier-2 neutral, owned by `meta docs`), `api-docs`
// is a NATIVE generator: it is REGISTERED in the generator registry (ADR-0022
// Part 3) — so it appears in `gen --list` and is selectable by its stable name
// `api-docs`. It is NOT a `meta docs` mode.
//
// It is NOT (yet) part of the default `meta gen` scaffold suite: it is
// registry-listed but not auto-run. Turning it on by default in the scaffold,
// and surfacing the agent form (AGENT-API.md) to a coding agent via a pointer
// from the installed `.metaobjects/` context, are tracked as agent-context-
// coordination follow-ups — deliberately deferred here to avoid colliding with
// the live agent-context work.

import type { MetaObject } from "@metaobjectsdev/metadata";
import type { Generator, GeneratorFactory, EmittedFile } from "../generator.js";
import {
  docPageOutputPath,
  surfaceCrossHref,
  assertNoDuplicateDocPaths,
  type DocPageNode,
  type DocPagePlacement,
} from "../docs-paths.js";
import { projectProvider } from "../render-engine/framework-provider.js";
import { buildApiModel } from "./api-model.js";
import {
  renderEntityApiPage,
  renderApiIndex,
  renderAgentApi,
} from "./api-doc-render.js";

// All api-docs artifacts live under this sub-directory of the codegen out dir.
// Per-unit pages fold further under their package path (package layout); the
// index + agent form stay at the api root (their links are computed relative to
// it via the same docPageHref the renderers use).
//
// The DEFAULT prefix is `docs/api` — byte-identical to the historical `meta gen`
// behaviour + goldens. The unified `meta docs` command (which writes everything
// under one docs root, `./docs`) overrides it via `subDir:'api'` so the api
// surface emits `api/<Node>.md` rather than doubling to `./docs/docs/api`.
const DEFAULT_API_DIR = "docs/api";

export interface ApiDocsFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
  /** Output prefix for all api-docs artifacts. Default `docs/api`. */
  subDir?: string;
  /** When true, the model surface is emitted alongside the api surface (at the
   *  docs root), so each api entity page cross-links back to its model page. The
   *  href is computed via the shared `surfaceCrossHref` so it resolves in BOTH
   *  layouts. ABSENT/false ⇒ default api output byte-identical. */
  modelSurface?: boolean;
}

/**
 * @deprecated ADR-0025: `meta docs` is the single door for ALL docs. `apiDocsFile()`
 * stays as the INTERNAL engine of the docs door's api surface — do NOT add it to a
 * `meta gen` config / the generators array. Use `meta docs` (it emits the api surface
 * alongside the model surface). A `meta gen` config that lists it is warned + skipped.
 */
export const apiDocsFile = function apiDocsFile(opts?: ApiDocsFileOpts): Generator {
  const generator: Generator = {
    name: "api-docs",
    generate(ctx) {
      const provider = projectProvider(ctx.projectRoot ?? process.cwd());
      const layout = ctx.config.outputLayout ?? "flat";

      // Per-call output prefix. Default `docs/api`; `meta docs` passes `api`.
      const apiDir = opts?.subDir ?? DEFAULT_API_DIR;
      const indexFilename = `${apiDir}/README.md`;
      const agentFilename = `${apiDir}/AGENT-API.md`;

      // ONE ApiModel feeds every form (Task-1 builder; Task-2 renderers). The
      // pkMap is reused from the run's renderContext when present (the real gen
      // run always provides it) and derived otherwise.
      // Auto-detect: document the OPT-IN Hono CRUD surface iff the Hono routes
      // generator is actually in the run. The runner aggregates each generator's
      // `emitsHonoRoutes` marker into ctx.config.includeHonoRoutes, so api-docs
      // "just works" — it documents Hono exactly when `routesFileHono` is wired,
      // and omits it (Fastify-only) otherwise. No explicit opt needed.
      const model = buildApiModel(ctx.loadedRoot, {
        loadedRoot: ctx.loadedRoot,
        outputLayout: layout,
        includeHonoRoutes: ctx.config.includeHonoRoutes ?? false,
        ...(ctx.renderContext?.pkMap !== undefined && { pkMap: ctx.renderContext.pkMap }),
      });

      // Track (path, fqn) for the SAME hard collision backstop docsFile() uses —
      // two units that resolve to one path (flat, cross-package short-name clash)
      // throw rather than silently overwrite.
      const placements: DocPagePlacement[] = [];

      // Per-unit human page. Placement is collision-safe via docPageOutputPath
      // off {name, effective package}, prefixed under the api dir; the index
      // (renderApiIndex) computes its links from the SAME {name, package}, so a
      // link always points at the page's real location in BOTH layouts.
      const files: EmittedFile[] = model.units.map((unit) => {
        const node: DocPageNode = { name: unit.node, package: unit.package };
        const path = `${apiDir}/${docPageOutputPath(layout, node)}`;
        placements.push({ path, fqn: unit.package ? `${unit.package}::${unit.node}` : unit.node });
        // Cross-link back to the sibling model page, when emitted. The model page
        // lives at the docs root at `<placement>`; this api page lives at
        // `<apiDir>/<placement>`. The href is derived from the SAME
        // docPageOutputPath placement via surfaceCrossHref so it resolves in both
        // layouts. ABSENT otherwise.
        const modelPageHref = opts?.modelSurface
          ? surfaceCrossHref(path, docPageOutputPath(layout, node))
          : undefined;
        return { path, content: renderEntityApiPage(unit, provider, modelPageHref) };
      });

      // The consolidated human index (README.md) + the condensed agent form,
      // both at the api root. Only emitted when at least one unit page exists.
      if (files.length > 0) {
        placements.push({ path: indexFilename, fqn: "<the api-docs index page>" });
        placements.push({ path: agentFilename, fqn: "<the api-docs agent form>" });
        files.unshift(
          { path: indexFilename, content: renderApiIndex(model, layout, provider) },
          { path: agentFilename, content: renderAgentApi(model, provider) },
        );
      }

      // Hard backstop against silent overwrite (ALL layouts): throw naming both
      // colliding FQNs + the path. Same guard docsFile() reuses.
      assertNoDuplicateDocPaths(placements);

      return files;
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<ApiDocsFileOpts>;

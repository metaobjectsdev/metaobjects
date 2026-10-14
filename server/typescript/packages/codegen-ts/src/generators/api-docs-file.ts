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
// Output (all under `api/` in the `docs` target, unless `subDir` / `target` say otherwise):
//   • one `<Node>.md` per entity + template.output unit (the human page),
//   • `README.md` — the consolidated human index (GitHub treats it as landing),
//   • `AGENT-API.md` — the token-frugal agent form.
//
// Unlike `docs` (the language-neutral model pages), `api-docs` is NATIVE: it documents what
// this port's generators emit. Like every generator it runs when the project lists it, and
// only then (ADR-0034 Amendment 9).
//
// THE POINTER IS NO LONGER DEFERRED. This header used to record "surfacing the agent form
// (AGENT-API.md) to a coding agent via a pointer from the installed `.metaobjects/`
// context" as an agent-context-coordination follow-up. It was deferred, no roadmap item
// tracked it, and for as long as that held, the page existed and nothing routed an agent
// to it. `agent-context/templates/always-on.md.mustache` now names this file and the three
// `agent/` pages, and says when to read each. If you rename or move this artifact, that
// template is the other half.

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
import { buildApiModelForRun } from "./api-model.js";
import {
  renderEntityApiPage,
  renderApiIndex,
  renderAgentApi,
} from "./api-doc-render.js";
import { DOCS_TARGET_NAME } from "../docs-run.js";
import { docsTemplateRoot } from "../render-engine/framework-provider.js";

// All api-docs artifacts live under this sub-directory of the target's out dir.
// Per-unit pages fold further under their package path (package layout); the
// index + agent form stay at the api root (their links are computed relative to
// it via the same docPageHref the renderers use).
const DEFAULT_API_DIR = "api";

export interface ApiDocsFileOpts {
  filter?: (entity: MetaObject) => boolean;
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
  /** Output prefix for all api-docs artifacts, under the target. Default `api`. */
  subDir?: string;
  /** Where the model pages are hosted when they are not written beside these, so each api
   *  page links back to `<modelBaseUrl>/<its model page>`. ABSENT: an api page links to its
   *  model page when `docsFile()` writes to the same target, and to none otherwise. */
  modelBaseUrl?: string;
  /** Whether each api page links back to its model page beside it. Default: whether
   *  `docsFile()` writes to the same target in this run (`ctx.docs.modelPages`). */
  modelSurface?: boolean;
}

export const apiDocsFile = function apiDocsFile(opts?: ApiDocsFileOpts): Generator {
  const apiDir = (opts?.subDir ?? DEFAULT_API_DIR).replace(/\/$/, "");
  const generator: Generator = {
    name: "api-docs",
    target: opts?.target ?? DOCS_TARGET_NAME,
    emitsApiDocs: { subDir: apiDir },
    generate(ctx) {
      const provider = projectProvider(docsTemplateRoot(ctx));
      const layout = ctx.config.outputLayout ?? "flat";

      // Whether each page links back to its model page: the model pages are hosted
      // elsewhere (`modelBaseUrl`), or `docsFile()` writes them to this same target.
      const modelBaseUrl = opts?.modelBaseUrl?.replace(/\/$/, "");
      const modelSurface = opts?.modelSurface ?? ctx.docs?.modelPages ?? false;
      const indexFilename = `${apiDir}/README.md`;
      const agentFilename = `${apiDir}/AGENT-API.md`;

      // ONE ApiModel feeds every form (Task-1 builder; Task-2 renderers). The facts of the
      // run it reads (layout, whether Hono routes are wired, the verbs the routes generators
      // mount, `apiPrefix`, the pk map) are gathered by `buildApiModelForRun`, which the
      // reference template calls too, so an owned copy never restates them and cannot fall
      // behind on one.
      const model = buildApiModelForRun(ctx);

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
        const modelPageHref = modelBaseUrl !== undefined && modelBaseUrl !== ""
          ? `${modelBaseUrl}/${docPageOutputPath(layout, node)}`
          : modelSurface
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
  return generator;
} as GeneratorFactory<ApiDocsFileOpts>;

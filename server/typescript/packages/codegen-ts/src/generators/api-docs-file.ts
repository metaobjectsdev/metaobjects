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
// is a NATIVE generator: it ships in the recommended `meta gen` suite and is
// registered native in the generator registry (ADR-0022 Part 3). It is NOT a
// `meta docs` mode.

import type { MetaObject } from "@metaobjectsdev/metadata";
import type { Generator, GeneratorFactory, EmittedFile } from "../generator.js";
import {
  docPageOutputPath,
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
const API_DIR = "docs/api";
const INDEX_FILENAME = `${API_DIR}/README.md`;
const AGENT_FILENAME = `${API_DIR}/AGENT-API.md`;

export interface ApiDocsFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

export const apiDocsFile = function apiDocsFile(opts?: ApiDocsFileOpts): Generator {
  const generator: Generator = {
    name: "api-docs",
    generate(ctx) {
      const provider = projectProvider(ctx.projectRoot ?? process.cwd());
      const layout = ctx.config.outputLayout ?? "flat";

      // ONE ApiModel feeds every form (Task-1 builder; Task-2 renderers). The
      // pkMap is reused from the run's renderContext when present (the real gen
      // run always provides it) and derived otherwise.
      const model = buildApiModel(ctx.loadedRoot, {
        loadedRoot: ctx.loadedRoot,
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
        const path = `${API_DIR}/${docPageOutputPath(layout, node)}`;
        placements.push({ path, fqn: unit.package ? `${unit.package}::${unit.node}` : unit.node });
        return { path, content: renderEntityApiPage(unit, provider) };
      });

      // The consolidated human index (README.md) + the condensed agent form,
      // both at the api root. Only emitted when at least one unit page exists.
      if (files.length > 0) {
        placements.push({ path: INDEX_FILENAME, fqn: "<the api-docs index page>" });
        placements.push({ path: AGENT_FILENAME, fqn: "<the api-docs agent form>" });
        files.unshift(
          { path: INDEX_FILENAME, content: renderApiIndex(model, layout, provider) },
          { path: AGENT_FILENAME, content: renderAgentApi(model, provider) },
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

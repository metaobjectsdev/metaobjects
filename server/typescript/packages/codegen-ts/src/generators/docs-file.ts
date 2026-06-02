// docsFile() — emits `<Entity>.md` next to each generated entity module.
//
// rc.12+: structured around a shared Mustache template at
// `templates/docs/entity-page.md.mustache` + a data builder at
// `docs-data-builder.ts`. Adopters can override the framework template by
// dropping their own `templates/docs/entity-page.md.mustache` into the
// project root (resolved via the project-then-framework provider chain).
//
// docsFile() calls `render()` directly rather than wrapping
// `templateGenerator()` because the per-entity output path depends on
// `GenContext.config.outputLayout`, which the generic templateGenerator
// `walk(root)` signature doesn't expose. Other future docs-style adopters
// with ctx-free walks (single-file aggregators, etc.) compose
// `templateGenerator()` directly.
//
// The conformance fixture (`fixtures/conformance/docs-file-basic`) gates
// byte-identity — the codegen output must match the hand-coded rc.11
// byte-for-byte. If you're hacking on this and the conformance test
// breaks, the refactor is the bug, not the fixture.

import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { TYPE_TEMPLATE, TEMPLATE_SUBTYPE_OUTPUT } from "@metaobjectsdev/metadata";
import { render } from "@metaobjectsdev/render";
import type { Provider } from "@metaobjectsdev/render";
import type { Generator, GeneratorFactory, EmittedFile } from "../generator.js";
import {
  docPageOutputPath,
  docPageHref,
  docPageNode,
  assertNoDuplicateDocPaths,
  type DocPageNode,
  type DocPagePlacement,
} from "../docs-paths.js";
import { projectProvider } from "../render-engine/framework-provider.js";
import { renderMermaidErBlock } from "../templates/mermaid-er.js";
import { buildEntityDocData } from "./docs-data-builder.js";
import { buildTemplateDocData } from "./template-doc-builder.js";
import type { OutputLayout } from "../import-path.js";

// The neutral OVERVIEW/index page. GitHub (and most doc-site renderers) treat a
// folder's README.md as its landing page, so the model overview lands here.
const INDEX_FILENAME = "README.md";
// The index lives at the docs ROOT (package-less) in BOTH layouts — links are
// computed relative to root via docPageHref.
const INDEX_NODE: DocPageNode = { name: "README" };

export interface DocsFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

const TEMPLATE_REF = "docs/entity-page.md";
// The NEUTRAL render-contract page emitted per `template.output` node — a
// sibling artifact, distinct from the entity page (Task 3).
const TEMPLATE_PAGE_REF = "docs/template-page.md";

/** Render one docs page, wrapping any engine error with the page ref + output
 *  path so a template failure points at the exact page (shared by the entity
 *  and template.output emission paths — identical error contract). */
function renderDocPage(ref: string, payload: unknown, provider: Provider, path: string): string {
  try {
    return render({ ref, payload, provider, format: "markdown" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`docs-file: failed rendering '${ref}' for '${path}': ${msg}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}

/**
 * @deprecated ADR-0021 D1: `meta docs` is the single door for documentation.
 * `docsFile()` stays as the INTERNAL engine that `meta docs` calls — do NOT add
 * it to a `meta gen` config / the public generator surface. It is flagged
 * neutral in the generator registry (`--list`) and is not part of the
 * recommended native `meta gen` suite. Use `meta docs` instead.
 */
export const docsFile = function docsFile(opts?: DocsFileOpts): Generator {
  const generator: Generator = {
    name: "docs-file",
    async generate(ctx) {
      if (!ctx.renderContext) {
        throw new Error("docs-file: renderContext is required (provided by runGen)");
      }
      const rc = ctx.renderContext;
      const provider = projectProvider(ctx.projectRoot ?? process.cwd());
      const layout = ctx.config.outputLayout ?? "flat";
      // Track every (path, fqn) so we can hard-error on a collision (defense
      // against silent doc-page overwrite) AFTER all pages are placed.
      const placements: DocPagePlacement[] = [];
      // Collect the placement nodes of each linkable page so the OVERVIEW/index
      // (README.md) can link them via the SAME docPageHref used everywhere else
      // (links resolve in flat AND package layout). Grouped entity vs template.
      const entityNodes: DocPageNode[] = [];
      const templateNodes: DocPageNode[] = [];
      const files: EmittedFile[] = ctx.loadedRoot
        .objects()
        .filter(ctx.matches)
        .map((entity: MetaObject) => {
          const node = docPageNode(entity);
          entityNodes.push(node);
          const path = docPageOutputPath(layout, node);
          placements.push({ path, fqn: entity.resolutionKey() });
          const payload = buildEntityDocData(entity, {
            dialect: rc.dialect,
            layout,
            ...(rc.columnNamingStrategy !== undefined && {
              columnNamingStrategy: rc.columnNamingStrategy,
            }),
            loadedRoot: rc.loadedRoot,
          });
          return { path, content: renderDocPage(TEMPLATE_REF, payload, provider, path) };
        });

      // ALSO emit one NEUTRAL render-contract page per `template.output` node —
      // a sibling artifact, distinct from the entity page. Raw node name → file
      // (`<name>.md`), agreeing with the entity Used-by back-link target.
      for (const child of ctx.loadedRoot.ownChildren()) {
        if (child.type !== TYPE_TEMPLATE || child.subType !== TEMPLATE_SUBTYPE_OUTPUT) continue;
        const node = docPageNode(child);
        templateNodes.push(node);
        const path = docPageOutputPath(layout, node);
        placements.push({ path, fqn: child.resolutionKey() });
        const payload = buildTemplateDocData(child, { layout, loadedRoot: ctx.loadedRoot });
        files.push({ path, content: renderDocPage(TEMPLATE_PAGE_REF, payload, provider, path) });
      }

      // Emit the neutral OVERVIEW/index page (README.md) at the docs root: the
      // whole-model Mermaid ER diagram (reusing the single shared
      // renderMermaidErBlock builder — no duplicated ER logic, ADR-0020) plus a
      // navigable index linking every entity + template page. Prepended so it is
      // the first file (and so README is included in the collision backstop).
      // Only emitted when at least one page exists — an all-filtered/empty run
      // produces nothing (no orphan landing page with an empty diagram).
      if (files.length > 0) {
        const indexContent = renderIndexPage(ctx.loadedRoot, layout, entityNodes, templateNodes);
        placements.push({ path: INDEX_FILENAME, fqn: "<the auto-generated overview/index page>" });
        files.unshift({ path: INDEX_FILENAME, content: indexContent });
      }

      // Hard backstop against silent overwrite (ALL layouts): two nodes that
      // resolve to the same output path → throw naming both FQNs + the path.
      assertNoDuplicateDocPaths(placements);

      return files;
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<DocsFileOpts>;

/** Build the neutral OVERVIEW/index page (README.md) body: a title + one-line
 *  description, the whole-model Mermaid ER diagram (the shared
 *  renderMermaidErBlock — ONE builder, no duplication), and a navigable index
 *  grouping entity pages vs template pages. Every link is computed with
 *  docPageHref(layout, INDEX_NODE, target) so it resolves in BOTH flat and
 *  package layout (the index lives at the docs root). Fully neutral — Mermaid +
 *  entity/template names + relationships only. */
function renderIndexPage(
  root: MetaRoot,
  layout: OutputLayout,
  entityNodes: DocPageNode[],
  templateNodes: DocPageNode[],
): string {
  const pkg = root.package;
  const out: string[] = [];
  out.push("# Data Model");
  out.push("");
  out.push(
    pkg !== undefined && pkg.length > 0
      ? `Overview of the \`${pkg}\` metadata model — entities, their relationships, and output templates.`
      : "Overview of the metadata model — entities, their relationships, and output templates.",
  );
  out.push("");

  // The whole-model ER diagram (shared neutral builder). Per-entity prose stays
  // on each entity page; only the fenced erDiagram block lives on the overview.
  out.push("## Diagram");
  out.push("");
  out.push(renderMermaidErBlock(root));
  out.push("");

  // Navigable index — grouped, sorted by name for stable output. Links resolve
  // in both layouts because docPageHref derives them from the same placement.
  const byName = (a: DocPageNode, b: DocPageNode) => a.name.localeCompare(b.name);
  if (entityNodes.length > 0) {
    out.push("## Entities");
    out.push("");
    for (const node of [...entityNodes].sort(byName)) {
      out.push(`- [${node.name}](${docPageHref(layout, INDEX_NODE, node)})`);
    }
    out.push("");
  }
  if (templateNodes.length > 0) {
    out.push("## Templates");
    out.push("");
    for (const node of [...templateNodes].sort(byName)) {
      out.push(`- [${node.name}](${docPageHref(layout, INDEX_NODE, node)})`);
    }
    out.push("");
  }

  // Trailing newline (one), matching the per-page convention.
  return out.join("\n").replace(/\n+$/, "\n");
}

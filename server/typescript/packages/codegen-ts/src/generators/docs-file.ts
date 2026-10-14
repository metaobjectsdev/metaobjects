// docsFile() — the `docs` generator: one neutral Markdown page per object and per template,
// and an overview (README.md) with the whole-model ER diagram. It writes to the `docs` target
// unless told otherwise (ADR-0034 Amendment 9).
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
import { TYPE_TEMPLATE } from "@metaobjectsdev/metadata";
import type { Generator, GeneratorFactory, EmittedFile } from "../generator.js";
import {
  docPageOutputPath,
  docPageHref,
  docPageNode,
  apiSurfaceHref,
  assertNoDuplicateDocPaths,
  type DocPageNode,
  type DocPagePlacement,
} from "../docs-paths.js";
import { docsTemplateRoot, projectProvider } from "../render-engine/framework-provider.js";
import { renderDocPage } from "../render-engine/doc-page.js";
import { renderMermaidErBlock } from "../templates/mermaid-er.js";
import { buildEntityDocData } from "./docs-data-builder.js";
import { isReport, servedReport } from "../source-detect.js";
import { buildTemplateDocData } from "./template-doc-builder.js";
import type { OutputLayout } from "../import-path.js";
import type { ApiSurface } from "../metaobjects-config.js";
import { DOCS_TARGET_NAME, type DocsApiSurface } from "../docs-run.js";
import { apiLabel } from "./api-label.js";

// The neutral OVERVIEW/index page. GitHub (and most doc-site renderers) treat a
// folder's README.md as its landing page, so the model overview lands here.
const INDEX_FILENAME = "README.md";
// The index lives at the docs ROOT (package-less) in BOTH layouts — links are
// computed relative to root via docPageHref.
const INDEX_NODE: DocPageNode = { name: "README" };

export interface DocsFileOpts {
  filter?: (entity: MetaObject) => boolean;
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
  /** The api reference pages each model page and the index link to, each under its own
   *  sub-directory of the docs root, with a label (or a language key, `{ lang: "java" }`,
   *  labelled for you). Every href is computed via the shared `apiSurfaceHref`, so it
   *  resolves relative in BOTH layouts, or absolute when a surface gives a `baseUrl`.
   *
   *  ABSENT: the api pages this run writes to the same target (`apiDocsFile()`), which is
   *  the whole list in a TypeScript-only project. Give it to link another port's pages too,
   *  and then list every surface, this port's included. Empty: no links. */
  apiSurfaces?: Array<ApiSurface | { label: string; subDir: string; baseUrl?: string }>;
  /** A directory holding `docs/entity-page.md.mustache` / `docs/template-page.md.mustache`
   *  overrides, relative to the project. Default: the project's own `templates/`. */
  templates?: string;
}

/** The option's surfaces with their labels: `{ lang }` is labelled by `apiLabel`. */
function labelled(surfaces: NonNullable<DocsFileOpts["apiSurfaces"]>): DocsApiSurface[] {
  return surfaces.map((s) => ({
    label: "label" in s ? s.label : apiLabel(s.lang),
    subDir: s.subDir,
    ...(s.baseUrl !== undefined && { baseUrl: s.baseUrl }),
  }));
}

const TEMPLATE_REF = "docs/entity-page.md";
// The NEUTRAL render-contract page emitted per `template.output` node — a
// sibling artifact, distinct from the entity page (Task 3).
const TEMPLATE_PAGE_REF = "docs/template-page.md";

export const docsFile = function docsFile(opts?: DocsFileOpts): Generator {
  const generator: Generator = {
    name: "docs-file",
    target: opts?.target ?? DOCS_TARGET_NAME,
    emitsModelDocs: true,
    async generate(ctx) {
      if (!ctx.renderContext) {
        throw new Error("docs-file: renderContext is required (provided by runGen)");
      }
      const rc = ctx.renderContext;
      const provider = projectProvider(docsTemplateRoot(ctx, opts?.templates));
      const layout = ctx.config.outputLayout ?? "flat";
      // One {label, href} per api surface, every href computed via the shared
      // `apiSurfaceHref` from the FROM page's own output path (so it resolves
      // relative in BOTH layouts, or absolute when the surface declares a
      // baseUrl). The api page for a node lives at `<subDir>/<same placement>`,
      // so the from-path doubles as the page placement. ABSENT/empty surfaces ⇒
      // undefined → output byte-identical to historical model-only runs.
      //
      // Which surfaces those are: the option when given, else the api pages the run writes
      // to this target, which the runner reads off the declared generators (docs-run.ts).
      const apiSurfaces = opts?.apiSurfaces !== undefined ? labelled(opts.apiSurfaces) : ctx.docs?.apiSurfaces;
      const apiRefsFor = (fromPath: string): Array<{ label: string; href: string }> | undefined =>
        apiSurfaces?.map((s) => ({ label: s.label, href: apiSurfaceHref(fromPath, s, fromPath) }));
      // Track every (path, fqn) so we can hard-error on a collision (defense
      // against silent doc-page overwrite) AFTER all pages are placed.
      const placements: DocPagePlacement[] = [];
      // Collect the placement nodes of each linkable page so the OVERVIEW/index
      // (README.md) can link them via the SAME docPageHref used everywhere else
      // (links resolve in flat AND package layout). Grouped entity vs template.
      const entityNodes: DocPageNode[] = [];
      const reportNodes: DocPageNode[] = [];
      const templateNodes: DocPageNode[] = [];
      const files: EmittedFile[] = ctx.loadedRoot
        .objects()
        .filter(ctx.matches)
        .map((entity: MetaObject) => {
          const node = docPageNode(entity);
          // FR-044: every report gets a page, served or not (its columns come from
          // `reportShape`). It is listed under "Reports" on the index, not "Entities".
          (isReport(entity) ? reportNodes : entityNodes).push(node);
          const path = docPageOutputPath(layout, node);
          placements.push({ path, fqn: entity.resolutionKey() });
          // Cross-link to the sibling api surfaces, when emitted (shared builder). A
          // report that is not served has no api unit in any port (Table G), so its page
          // links to none: the link would point at a page nothing writes.
          const apiRefs = isReport(entity) && !servedReport(entity) ? undefined : apiRefsFor(path);
          const payload = buildEntityDocData(entity, {
            dialect: rc.dialect,
            layout,
            ...(rc.columnNamingStrategy !== undefined && {
              columnNamingStrategy: rc.columnNamingStrategy,
            }),
            loadedRoot: rc.loadedRoot,
            ...(apiRefs !== undefined && { apiRefs }),
          });
          return { path, content: renderDocPage(TEMPLATE_REF, payload, provider, path) };
        });

      // ALSO emit one NEUTRAL render-contract page per top-level `template.*` node
      // — a sibling artifact, distinct from the entity page. Raw node name → file
      // (`<name>.md`), agreeing with the entity Used-by back-link target.
      //
      // EVERY template subtype, not just `template.output`: the api-docs surface
      // has always emitted `api/<lang>/<pkg>/<Prompt>.md` for a top-level
      // `template.prompt` (it documents the prompt-render handle), and that page
      // carries a "Model / metadata" back-link to `<pkg>/<Prompt>.md`. While this
      // loop filtered to outputs, that link pointed at a page nothing wrote — a
      // broken link in every shipped doc tree containing a prompt. ADR-0052 makes
      // it worse rather than better: a responding prompt now carries the whole
      // inbound tier, so it is the LAST node a doc tree should omit.
      // ADR-0039: resolving — root has no super (children()==ownChildren()).
      for (const child of ctx.loadedRoot.children()) {
        if (child.type !== TYPE_TEMPLATE) continue;
        const node = docPageNode(child);
        templateNodes.push(node);
        const path = docPageOutputPath(layout, node);
        placements.push({ path, fqn: child.resolutionKey() });
        const payload = buildTemplateDocData(child, {
          layout,
          loadedRoot: ctx.loadedRoot,
          provider,
        });
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
        // The api index lives at `<subDir>/README.md` per surface; the model index
        // lives at the docs root, so the from-path is the root-level index path
        // (shared builder — same relative/absolute rule as the entity refs).
        const apiIndexRefs = apiRefsFor(INDEX_FILENAME);
        const indexContent = renderIndexPage(
          ctx.loadedRoot,
          layout,
          entityNodes,
          templateNodes,
          apiIndexRefs,
          reportNodes,
        );
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
  apiIndexRefs?: Array<{ label: string; href: string }>,
  reportNodes: DocPageNode[] = [],
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
  // FR-044: reports, after the entities they read from. Absent when the model has none.
  if (reportNodes.length > 0) {
    out.push("## Reports");
    out.push("");
    for (const node of [...reportNodes].sort(byName)) {
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

  // Cross-link to the GENERATED-SDK api reference indexes, when api surfaces are
  // emitted alongside the model surface — one bullet per language surface. ABSENT
  // or empty → no section (index byte-identical to model-only runs).
  if (apiIndexRefs !== undefined && apiIndexRefs.length > 0) {
    out.push("## API reference");
    out.push("");
    for (const ref of apiIndexRefs) {
      out.push(`- [${ref.label}](${ref.href})`);
    }
    out.push("");
  }

  // Trailing newline (one), matching the per-page convention.
  return out.join("\n").replace(/\n+$/, "\n");
}

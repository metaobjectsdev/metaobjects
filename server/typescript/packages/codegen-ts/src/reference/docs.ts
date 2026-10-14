// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/docs.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { docsFile } from "./codegen/generators/docs.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Markdown, with Mermaid for the diagrams. The pages import nothing.
// use-when:      you want to change the model documentation: which objects and templates
//                get a page, where the pages land, or how the overview page is laid out.
//                The packaged `docsFile()` writes these pages without this file; eject it
//                only to change them. To change the WORDING of a page you need no generator
//                at all: drop your own `templates/docs/entity-page.md.mustache` or
//                `templates/docs/template-page.md.mustache` in the project root.
// emits:         into the `docs` target (`targets.docs.outDir`, e.g. ./docs/generated):
//                README.md, the overview with the whole-model ER diagram and an index;
//                <Object>.md per object, reports included; <Template>.md per top-level
//                `template.*` node. Under `outputLayout: "package"` the pages fold under
//                their package path.
// customize:     which objects get a page (the `filter` option, and the two walks in
//                `generate`), where a page lands (`docPageOutputPath`), which template a
//                page renders (`ENTITY_PAGE_REF`, `TEMPLATE_PAGE_REF`) and the overview
//                page (`renderIndexPage`, all of it). Copied beside it, so yours too:
//                `buildEntityDocData` and `buildTemplateDocData`, which read the model into
//                the page payloads, and `renderMermaidErBlock`, the ER diagram. The page
//                templates (Mustache files) stay in the package; you override them by file
//                as above.
// composes-with: api-docs (each model page links to its api page, and back). The runner tells
//                both generators where the other's pages are, from the generators the
//                project lists in the same target (`ctx.docs`), so the links agree.
//
// HOW IT RUNS. Like every generator: list it in `generators` in metaobjects.config.ts, with
// a `docs` target declared, and `meta gen` writes the pages (`meta verify --codegen` checks
// them). Nothing writes documentation that the list does not declare.
//   targets: { docs: { outDir: "./docs/generated" } },
//   generators: [docsFile(), ...]
//
// Everything below imports the engine from `@metaobjectsdev/codegen-ts` (the generator base, the
// model walks, the naming tables), the node types and the template type name from
// `@metaobjectsdev/metadata`, and the code that writes the pages from `../generators/` and
// `../templates/`. `meta eject` copies those modules into your project, under
// `codegen/templates/`, and your copy of this file imports them from there: they are yours too.

import { TYPE_TEMPLATE, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import {
  apiSurfaceHref,
  assertNoDuplicateDocPaths,
  docPageHref,
  docPageNode,
  docPageOutputPath,
  isReport,
  projectProvider,
  servedReport,
  type DocPageNode,
  type DocPagePlacement,
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  type OutputLayout,
  type ApiSurface,
  apiLabel,
  docsTemplateRoot,
  DOCS_TARGET_NAME,
} from "@metaobjectsdev/codegen-ts/engine";
import { buildEntityDocData } from "../generators/docs-data-builder.js";
import { buildTemplateDocData } from "../generators/template-doc-builder.js";
import { renderDocPage } from "../render-engine/doc-page.js";
import { renderMermaidErBlock } from "../templates/mermaid-er.js";

export interface DocsFileOpts {
  /** Which objects get a page. Templates are not objects and always get theirs. */
  filter?: (entity: MetaObject) => boolean;
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
  /** The api reference pages to link, `{ label | lang, subDir, baseUrl? }` each. Default: the
   *  api pages the run writes to the same target. */
  apiSurfaces?: Array<ApiSurface | { label: string; subDir: string; baseUrl?: string }>;
  /** A directory whose `templates/` holds page overrides, relative to the project. Default:
   *  the project itself. */
  templates?: string;
}

// The overview page. GitHub (and most doc-site renderers) treat a folder's README.md as its
// landing page, so the model overview lands there, at the docs root in both layouts.
const INDEX_FILENAME = "README.md";
const INDEX_NODE: DocPageNode = { name: "README" };

// The Mustache templates the pages render. Resolved through the project-then-package
// provider chain, so a file of the same name under your `templates/` wins.
const ENTITY_PAGE_REF = "docs/entity-page.md";
const TEMPLATE_PAGE_REF = "docs/template-page.md";

export const docsFile = function docsFile(opts?: DocsFileOpts): Generator {
  const generator: Generator = {
    name: "docs-file",
    target: opts?.target ?? DOCS_TARGET_NAME,
    // Tells an api reference generator in the same target that there are model pages to
    // link back to.
    emitsModelDocs: true,
    async generate(ctx) {
      if (!ctx.renderContext) {
        throw new Error("docs-file: renderContext is required (provided by `meta gen`)");
      }
      const rc = ctx.renderContext;
      const provider = projectProvider(docsTemplateRoot(ctx, opts?.templates));
      const layout = ctx.config.outputLayout ?? "flat";

      // The api surfaces to link: the option, or the api pages the run writes to this
      // target. One link per surface, computed from the FROM page's own path so it resolves
      // in both layouts (or is absolute when the surface declares a `baseUrl`). None: the
      // pages link to none.
      const apiSurfaces = opts?.apiSurfaces !== undefined
        ? opts.apiSurfaces.map((s) => ({
            label: "label" in s ? s.label : apiLabel(s.lang),
            subDir: s.subDir,
            ...(s.baseUrl !== undefined && { baseUrl: s.baseUrl }),
          }))
        : ctx.docs?.apiSurfaces;
      const apiRefsFor = (fromPath: string): Array<{ label: string; href: string }> | undefined =>
        apiSurfaces?.map((s) => ({ label: s.label, href: apiSurfaceHref(fromPath, s, fromPath) }));

      // Every (path, node) placed, so a collision is refused after all pages are placed.
      const placements: DocPagePlacement[] = [];
      // What the overview page links to, by section.
      const entityNodes: DocPageNode[] = [];
      const reportNodes: DocPageNode[] = [];
      const templateNodes: DocPageNode[] = [];

      // OWNED: which objects get a page. `ctx.matches` is the `filter` option.
      const files: EmittedFile[] = ctx.loadedRoot
        .objects()
        .filter(ctx.matches)
        .map((entity: MetaObject) => {
          const node = docPageNode(entity);
          // Every report gets a page, served or not, listed under "Reports".
          (isReport(entity) ? reportNodes : entityNodes).push(node);
          // OWNED: where the page lands.
          const path = docPageOutputPath(layout, node);
          placements.push({ path, fqn: entity.resolutionKey() });
          // A report that is not served has no api page in any port, so its page links to
          // none: the link would point at a page nothing writes.
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
          return { path, content: renderDocPage(ENTITY_PAGE_REF, payload, provider, path) };
        });

      // OWNED: which templates get a page. Every top-level `template.*` node, prompts
      // included: the api surface writes a page for each and links back to this one, so
      // leaving one out leaves that link pointing at nothing.
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

      // The overview page, first, and only when at least one page exists: a run that
      // selected nothing writes no landing page with an empty diagram.
      if (files.length > 0) {
        const indexContent = renderIndexPage(
          ctx.loadedRoot,
          layout,
          entityNodes,
          templateNodes,
          apiRefsFor(INDEX_FILENAME),
          reportNodes,
        );
        placements.push({ path: INDEX_FILENAME, fqn: "<the auto-generated overview/index page>" });
        files.unshift({ path: INDEX_FILENAME, content: indexContent });
      }

      // Two nodes that resolve to one output path are refused, naming both and the path,
      // instead of one page silently overwriting the other.
      assertNoDuplicateDocPaths(placements);

      return files;
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  return generator;
} as GeneratorFactory<DocsFileOpts>;

/**
 * OWNED: the overview page (README.md). A title and one-line description, the whole-model
 * ER diagram, then an index grouping the pages. Every link goes through `docPageHref` from
 * the index's own placement, so it resolves in both the flat and the package layout.
 */
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

  // The whole-model ER diagram. Per-entity prose stays on each entity's own page.
  out.push("## Diagram");
  out.push("");
  out.push(renderMermaidErBlock(root));
  out.push("");

  // The index, grouped, each group sorted by name so the page is stable.
  const byName = (a: DocPageNode, b: DocPageNode) => a.name.localeCompare(b.name);
  if (entityNodes.length > 0) {
    out.push("## Entities");
    out.push("");
    for (const node of [...entityNodes].sort(byName)) {
      out.push(`- [${node.name}](${docPageHref(layout, INDEX_NODE, node)})`);
    }
    out.push("");
  }
  // Reports, after the entities they read from. Absent when the model has none.
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

  // One bullet per api surface emitted alongside. Absent when there is none.
  if (apiIndexRefs !== undefined && apiIndexRefs.length > 0) {
    out.push("## API reference");
    out.push("");
    for (const ref of apiIndexRefs) {
      out.push(`- [${ref.label}](${ref.href})`);
    }
    out.push("");
  }

  // Exactly one trailing newline, as every page has.
  return out.join("\n").replace(/\n+$/, "\n");
}

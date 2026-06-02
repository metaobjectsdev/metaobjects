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

import type { MetaObject } from "@metaobjectsdev/metadata";
import { TYPE_TEMPLATE, TEMPLATE_SUBTYPE_OUTPUT } from "@metaobjectsdev/metadata";
import { render } from "@metaobjectsdev/render";
import type { Generator, GeneratorFactory, EmittedFile } from "../generator.js";
import { entityOutputPath } from "../import-path.js";
import { projectProvider } from "../render-engine/framework-provider.js";
import { buildEntityDocData } from "./docs-data-builder.js";
import { buildTemplateDocData } from "./template-doc-builder.js";

export interface DocsFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

const TEMPLATE_REF = "docs/entity-page.md";
// The NEUTRAL render-contract page emitted per `template.output` node — a
// sibling artifact, distinct from the entity page (Task 3).
const TEMPLATE_PAGE_REF = "docs/template-page.md";

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
      const files: EmittedFile[] = ctx.loadedRoot
        .objects()
        .filter(ctx.matches)
        .map((entity: MetaObject) => {
          const path = entityOutputPath(layout, entity.package, `${entity.name}.md`);
          const payload = buildEntityDocData(entity, {
            dialect: rc.dialect,
            ...(rc.columnNamingStrategy !== undefined && {
              columnNamingStrategy: rc.columnNamingStrategy,
            }),
            loadedRoot: rc.loadedRoot,
          });
          let content: string;
          try {
            content = render({
              ref: TEMPLATE_REF,
              payload,
              provider,
              format: "markdown",
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `docs-file: failed rendering '${TEMPLATE_REF}' for '${path}': ${msg}`,
              { cause: err instanceof Error ? err : undefined },
            );
          }
          return { path, content };
        });

      // ALSO emit one NEUTRAL render-contract page per `template.output` node —
      // a sibling artifact, distinct from the entity page. Raw node name → file
      // (`<name>.md`), agreeing with the entity Used-by back-link target.
      for (const child of ctx.loadedRoot.ownChildren()) {
        if (child.type !== TYPE_TEMPLATE || child.subType !== TEMPLATE_SUBTYPE_OUTPUT) continue;
        const path = entityOutputPath(layout, child.package, `${child.name}.md`);
        const payload = buildTemplateDocData(child);
        let content: string;
        try {
          content = render({
            ref: TEMPLATE_PAGE_REF,
            payload,
            provider,
            format: "markdown",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `docs-file: failed rendering '${TEMPLATE_PAGE_REF}' for '${path}': ${msg}`,
            { cause: err instanceof Error ? err : undefined },
          );
        }
        files.push({ path, content });
      }

      return files;
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<DocsFileOpts>;

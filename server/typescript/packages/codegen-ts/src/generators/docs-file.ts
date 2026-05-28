// docsFile() — emits `<Entity>.md` next to each generated entity module.
//
// Markdown is port-agnostic: the same metadata produces the same documentation
// page regardless of dialect, output layout, or runtime target. The page covers
// description / type / source / package preamble; storage table + identity +
// relationships for table-backed entities; validation entry points; "used by"
// template cross-references; and the generated-code surface (which sibling
// files codegen produces). See `templates/docs-file.ts` for the body.

import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderDocsFile } from "../templates/docs-file.js";
import { entityOutputPath } from "../import-path.js";

export interface DocsFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

export const docsFile = function docsFile(opts?: DocsFileOpts): Generator {
  const generator: Generator = {
    name: "docs-file",
    generate: perEntity((entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("docs-file: renderContext is required (provided by runGen)");
      }
      const rc = ctx.renderContext;
      const generatorNames = readGeneratorNames(ctx);
      return {
        path: entityOutputPath(
          ctx.config.outputLayout ?? "flat",
          entity.package,
          `${entity.name}.md`,
        ),
        content: renderDocsFile(entity, {
          dialect: rc.dialect,
          columnNamingStrategy: rc.columnNamingStrategy,
          loadedRoot: rc.loadedRoot,
          generatorNames,
        }),
      };
    }),
  };
  if (opts?.filter) {
    generator.filter = opts.filter;
  }
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<DocsFileOpts>;

/**
 * `GenContext` does not currently carry the full generator list — that lives on
 * the resolved config inside the runner. Rather than thread a new field through
 * just to populate one optional markdown section, we always list every
 * potential companion. The "Generated code" section becomes "files that may be
 * generated alongside this one" — adopters cross-reference their own
 * `metaobjects.config.ts` to confirm which they actually wired in. This matches
 * the spec guidance "list them all and let the reader figure out which exist."
 */
function readGeneratorNames(_ctx: unknown): ReadonlySet<string> {
  return new Set(["queries-file", "routes-file", "routes-file-hono"]);
}

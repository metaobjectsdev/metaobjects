// docsFile() — emits `<Entity>.md` next to each generated entity module.
//
// rc.12+: refactored to use templateGenerator(). The Markdown structure now
// lives in `templates/docs/entity-page.md.mustache`; the data extraction lives
// in `buildEntityDocData()`. Adopters can override the framework template by
// dropping their own `templates/docs/entity-page.md.mustache` into the project
// root (resolved via the project-then-framework provider chain).
//
// The conformance fixture (`fixtures/conformance/docs-file-basic`) gates
// byte-identity through the refactor — the codegen output must match the
// hand-coded rc.11 byte-for-byte. If you're hacking on this and the
// conformance test breaks, the refactor is the bug, not the fixture.

import type { MetaObject } from "@metaobjectsdev/metadata";
import type { Generator, GeneratorFactory, GenContext } from "../generator.js";
import { entityOutputPath } from "../import-path.js";
import {
  templateGenerator,
  type TemplateGeneratorOpts,
} from "./template-generator.js";
import { buildEntityDocData } from "./docs-data-builder.js";

export interface DocsFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

/** The names of the generators that may emit sibling files for an entity.
 *  We always list them in the "Generated code" section — adopters cross-
 *  reference their own metaobjects.config.ts to confirm which are wired in.
 *  Matches the rc.11 behavior. */
const KNOWN_SIBLING_GENERATORS = new Set([
  "queries-file",
  "routes-file",
  "routes-file-hono",
]);

export const docsFile = function docsFile(opts?: DocsFileOpts): Generator {
  // We can't fully delegate to templateGenerator's `walk(root)` because the
  // per-entity output path depends on the runtime `outputLayout` (flat /
  // package), which only lives on `GenContext.config`. So docsFile wraps
  // templateGenerator and threads ctx through.
  const tgOpts: TemplateGeneratorOpts = {
    name: "docs-file",
    template: "docs/entity-page.md",
    format: "markdown",
    walk: () => [], // placeholder — real walk happens inside generate() below
  };
  const inner = templateGenerator(tgOpts);

  const generator: Generator = {
    name: "docs-file",
    async generate(ctx: GenContext) {
      if (!ctx.renderContext) {
        throw new Error("docs-file: renderContext is required (provided by runGen)");
      }
      const rc = ctx.renderContext;
      // Drive the templateGenerator by populating its walk via closure.
      const realWalk = (root: typeof ctx.loadedRoot) =>
        root.objects().filter(ctx.matches).map((entity: MetaObject) => ({
          data: buildEntityDocData(entity, {
            dialect: rc.dialect,
            ...(rc.columnNamingStrategy !== undefined
              ? { columnNamingStrategy: rc.columnNamingStrategy }
              : {}),
            loadedRoot: rc.loadedRoot,
            generatorNames: KNOWN_SIBLING_GENERATORS,
          }),
          outputPath: entityOutputPath(
            ctx.config.outputLayout ?? "flat",
            entity.package,
            `${entity.name}.md`,
          ),
        }));
      // Hot-swap walk on the underlying templateGenerator. (The factory
      // closes over `opts.walk`, so we mutate the options object's walk
      // reference here.)
      (tgOpts as { walk: typeof realWalk }).walk = realWalk;
      return inner.generate(ctx);
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<DocsFileOpts>;

// server/typescript/packages/codegen-ts/src/generators/extractor-file.ts
//
// Stock generator that emits one <TemplateName>.extractor.ts file per declared template.output
// node whose @format is json/xml. Wraps renderExtractor() from templates/extractor.ts.
//
// The emitted extractor sits over the output-parser's nested-capable extract and turns dirty LLM
// text into the strict typed payload graph. It imports from the sibling <Name>.response.ts (the
// output-parser) and from each payload value-object's own entity module (<VO>.ts, emitted by
// entityFile), so run it alongside outputParser() + entityFile().
//
// Consumer wiring (metaobjects.config.ts):
//   generators: [..., outputParser(), extractor()]
//
// Custom output directory:
//   generators: [..., extractor({ outDir: "src/generated/outputs" })]

import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
import { inboundTemplates, responseShape } from "../templates/find-inbound.js";
import { renderExtractor } from "../templates/extractor.js";

export interface ExtractorOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

export const extractor = function extractor(opts?: ExtractorOpts): Generator {
  const dirPrefix = opts?.outDir ? `${opts.outDir.replace(/\/$/, "")}/` : "";
  const generator: Generator = {
    name: "extractor",
    generate: oncePerRun((_entities, ctx) => {
      const files: EmittedFile[] = [];
      for (const t of inboundTemplates(ctx.loadedRoot)) {
        // The extract tier sits over the parser's extract API. Since ADR-0052 every
        // responding prompt emits one (@responseFormat is a closed json|xml set), so
        // the only remaining skip is an unresolvable @responseRef.
        if (!responseShape(ctx.loadedRoot, t)) continue;
        files.push({
          path: `${dirPrefix}${t.name}.extractor.ts`,
          // ADR-0044/#228: thread ctx.renderContext (when present — runGen always supplies it;
          // a hand-rolled GenContext in a unit test may omit it, falling back to bare naming) so
          // a payload/nested value-object whose bare name collides across packages emits/imports
          // the entity-domain qualified name (Task 3's valueObjectEmittedName), matching
          // entityFile()'s module.
          content: renderExtractor(ctx.loadedRoot, t.name, ctx.renderContext),
        });
      }
      return files;
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<ExtractorOpts>;

// server/typescript/packages/codegen-ts/src/generators/extractor-file.ts
//
// Stock generator that emits one <TemplateName>.extractor.ts file per declared template.output
// node whose @format is json/xml. Wraps renderExtractor() from templates/extractor.ts.
//
// The emitted extractor sits over the output-parser's nested-capable extract and turns dirty LLM
// text into the strict typed payload graph. It imports from the sibling <Name>.output.ts (the
// output-parser) and from each payload value-object's own entity module (<VO>.ts, emitted by
// entityFile), so run it alongside outputParser() + entityFile().
//
// Consumer wiring (metaobjects.config.ts):
//   generators: [..., outputParser(), extractor()]
//
// Custom output directory:
//   generators: [..., extractor({ outDir: "src/generated/outputs" })]

import { TYPE_TEMPLATE, TEMPLATE_SUBTYPE_OUTPUT, TEMPLATE_ATTR_FORMAT } from "@metaobjectsdev/metadata";
import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
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
      const outputs = ctx.loadedRoot
        .ownChildren()
        .filter((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_OUTPUT);
      const files: EmittedFile[] = [];
      for (const t of outputs) {
        // The extract tier requires the extract API, which only json/xml output-parsers emit.
        const format = ((t.ownAttr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text").toLowerCase();
        if (format !== "json" && format !== "xml") continue;
        files.push({
          path: `${dirPrefix}${t.name}.extractor.ts`,
          content: renderExtractor(ctx.loadedRoot, t.name),
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

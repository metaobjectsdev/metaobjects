// server/typescript/packages/codegen-ts/src/generators/output-parser-file.ts
//
// Stock generator that emits one <TemplateName>.output.ts file per declared
// template.output node. Wraps renderOutputParser() from templates/output-parser.ts.
//
// Consumer wiring (metaobjects.config.ts):
//   generators: [..., promptRender(), outputParser()]
//
// Custom output directory:
//   generators: [..., outputParser({ outDir: "src/generated/outputs" })]

import { TYPE_TEMPLATE, TEMPLATE_SUBTYPE_OUTPUT } from "@metaobjectsdev/metadata";
import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
import { renderOutputParser } from "../templates/output-parser.js";

export interface OutputParserOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

export const outputParser = function outputParser(opts?: OutputParserOpts): Generator {
  const dirPrefix = opts?.outDir ? `${opts.outDir.replace(/\/$/, "")}/` : "";
  const generator: Generator = {
    name: "output-parser",
    generate: oncePerRun((_entities, ctx) => {
      const outputs = ctx.loadedRoot
        .ownChildren()
        .filter((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_OUTPUT);
      const files: EmittedFile[] = [];
      for (const t of outputs) {
        files.push({
          path: `${dirPrefix}${t.name}.output.ts`,
          content: renderOutputParser(ctx.loadedRoot, t.name),
        });
      }
      return files;
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<OutputParserOpts>;

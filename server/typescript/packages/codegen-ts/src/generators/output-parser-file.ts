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

import { TEMPLATE_SUBTYPE_OUTPUT } from "@metaobjectsdev/metadata";
import { findTemplates } from "../templates/find-templates.js";
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
      const outputs = findTemplates(ctx.loadedRoot, TEMPLATE_SUBTYPE_OUTPUT);
      const files: EmittedFile[] = [];
      for (const t of outputs) {
        files.push({
          path: `${dirPrefix}${t.name}.output.ts`,
          // ADR-0044/#228: thread ctx.renderContext (when present — runGen always supplies it;
          // a hand-rolled GenContext in a unit test may omit it, falling back to bare naming) so
          // a payload/nested value-object whose bare name collides across packages emits the
          // entity-domain qualified mirror type (Task 3's valueObjectEmittedName), and the
          // payload runtime lookup baked FQN-safe.
          content: renderOutputParser(ctx.loadedRoot, t.name, ctx.renderContext),
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

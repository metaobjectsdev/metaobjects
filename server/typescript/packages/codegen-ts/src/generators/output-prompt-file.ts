// server/typescript/packages/codegen-ts/src/generators/output-prompt-file.ts
//
// FR-010 stock generator that emits one <PromptName>.responseFormat.ts file per
// responding `template.prompt` — the response-format fragment ("produce your answer
// like this"). Wraps renderOutputPrompt() from templates/output-prompt.ts.
//
// ADR-0052: gated on `@responseRef` presence, like every other inbound generator.
// It previously keyed on `template.output` + a json/xml `@format` gate, which is
// how a fragment that instructs an LLM came to be emitted from the subtype defined
// as "every rendered artifact other than an LLM prompt".
//
// Consumer wiring (metaobjects.config.ts):
//   generators: [..., promptRender(), outputParser(), outputPrompt()]
//
// Custom output directory:
//   generators: [..., outputPrompt({ outDir: "src/generated/outputs" })]

import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
import { inboundTemplates, responseShape } from "../templates/find-inbound.js";
import { renderOutputPrompt } from "../templates/output-prompt.js";

export interface OutputPromptOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

export const outputPrompt = function outputPrompt(opts?: OutputPromptOpts): Generator {
  const dirPrefix = opts?.outDir ? `${opts.outDir.replace(/\/$/, "")}/` : "";
  const generator: Generator = {
    name: "output-prompt",
    generate: oncePerRun((_entities, ctx) => {
      const root = ctx.loadedRoot;
      const files: EmittedFile[] = [];
      for (const t of inboundTemplates(root)) {
        // @responseRef must resolve to a value-object (same contract as the parser).
        if (!responseShape(root, t)) continue;
        files.push({
          path: `${dirPrefix}${t.name}.responseFormat.ts`,
          content: renderOutputPrompt(root, t.name),
        });
      }
      return files;
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<OutputPromptOpts>;

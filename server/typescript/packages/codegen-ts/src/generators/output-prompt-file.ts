// server/typescript/packages/codegen-ts/src/generators/output-prompt-file.ts
//
// FR-010 stock generator that emits one <TemplateName>.prompt.ts file per json/xml
// template.output node — the output-format prompt fragment ("produce your answer
// like this"). Wraps renderOutputPrompt() from templates/output-prompt.ts. Skips
// text-format outputs and outputs whose @payloadRef doesn't resolve to a value-object
// (same contract as the output-parser generator).
//
// Consumer wiring (metaobjects.config.ts):
//   generators: [..., promptRender(), outputParser(), outputPrompt()]
//
// Custom output directory:
//   generators: [..., outputPrompt({ outDir: "src/generated/outputs" })]

import {
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";
import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
import { renderOutputPrompt, templateSupportsPrompt } from "../templates/output-prompt.js";

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
      // ADR-0039: resolving — root has no super (children()==ownChildren()).
      const outputs = root
        .children()
        .filter((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_OUTPUT);
      const files: EmittedFile[] = [];
      for (const t of outputs) {
        // Only json/xml outputs get a renderable prompt fragment.
        if (!templateSupportsPrompt(t)) continue;
        // @payloadRef must resolve to a value-object (same contract as the parser).
        // ADR-0039: resolving — a template may inherit its @* refs/format/kind via extends.
        const payloadRef = t.attr(TEMPLATE_ATTR_PAYLOAD_REF);
        if (typeof payloadRef !== "string") continue;
        // ADR-0042: a bare @payloadRef resolves in the template's package.
        const vo = resolveObjectRef(root, payloadRef, t.package ?? t.fileDefaultPackage ?? "").node;
        if (!vo) continue;
        files.push({
          path: `${dirPrefix}${t.name}.prompt.ts`,
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

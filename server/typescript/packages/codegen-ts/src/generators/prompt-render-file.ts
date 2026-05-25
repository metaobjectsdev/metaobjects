// Stock generator that wraps generatePayloadInterfaces() + generateRenderHandle()
// from payload-codegen.ts into a Generator factory. Emits ONE file aggregating
// typed payload interfaces (for object.value entities) and render handles (for
// template.prompt nodes).
//
// Consumer wiring (metaobjects.config.ts):
//   generators: [..., promptRender()]
//
// Custom output path:
//   generators: [..., promptRender({ outFile: "src/render/generated/prompts.ts" })]

import { TYPE_TEMPLATE, TEMPLATE_SUBTYPE_PROMPT, OBJECT_SUBTYPE_VALUE } from "@metaobjectsdev/metadata";
import {
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
import {
  generatePayloadInterfaces,
  generateRenderHandle,
} from "../payload-codegen.js";

export interface PromptRenderOpts {
  /** Output file path relative to the target's outDir. Default: "prompts.ts". */
  outFile?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

export const promptRender = function promptRender(opts?: PromptRenderOpts): Generator {
  const outFile = opts?.outFile ?? "prompts.ts";
  const generator: Generator = {
    name: "prompt-render",
    generate: oncePerRun((entities, ctx) => {
      const payloads = entities.filter((e) => e.subType === OBJECT_SUBTYPE_VALUE);
      const prompts = ctx.loadedRoot
        .ownChildren()
        .filter((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_PROMPT);

      if (payloads.length === 0 && prompts.length === 0) {
        return [];
      }

      const parts: string[] = [];
      for (const p of payloads) {
        parts.push(generatePayloadInterfaces(ctx.loadedRoot, p.name));
      }
      // Strip the `import type { ... } from "./payloads.js"` line that
      // generateRenderHandle() emits for the standalone two-file scenario.
      // In the single-file output here the payload interfaces are already
      // defined above, so the import is a self-reference to a non-existent module.
      for (const t of prompts) {
        const handle = generateRenderHandle(ctx.loadedRoot, t.name)
          .split("\n")
          .filter((line) => !line.startsWith("import type {") || !line.includes("./payloads.js"))
          .join("\n");
        parts.push(handle);
      }
      return [{
        path: outFile,
        content: parts.filter((s) => s.length > 0).map((s) => s.trimEnd()).join("\n\n") + "\n",
      }];
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<PromptRenderOpts>;

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

import { TEMPLATE_SUBTYPE_PROMPT, OBJECT_SUBTYPE_VALUE } from "@metaobjectsdev/metadata";
import { findTemplates } from "../templates/find-templates.js";
import {
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
import {
  generatePayloadInterfacesBatch,
  generateRenderHandle,
} from "../payload-codegen.js";
import { GENERATED_HEADER } from "../constants.js";

export interface PromptRenderOpts {
  /** Output file path relative to the target's outDir. Default: "prompts.ts". */
  outFile?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

// Hoisted into the emitted file once. generateRenderHandle() emits this line
// per-handle (for the standalone scenario); we strip its per-handle copies.
const RENDER_IMPORT = `import { render, type Provider } from "@metaobjectsdev/render";`;

// Matches the `import type { ... } from "./payloads.js";` that generateRenderHandle
// emits for the standalone two-file scenario. In the single-file output here the
// payload interfaces are already defined above, so the import is dead.
function isStandalonePayloadImport(line: string): boolean {
  return line.startsWith("import type {") && line.includes('"./payloads.js"');
}

export const promptRender = function promptRender(opts?: PromptRenderOpts): Generator {
  const outFile = opts?.outFile ?? "prompts.ts";
  const generator: Generator = {
    name: "prompt-render",
    generate: oncePerRun((entities, ctx) => {
      const payloads = entities.filter((e) => e.subType === OBJECT_SUBTYPE_VALUE);
      const prompts = findTemplates(ctx.loadedRoot, TEMPLATE_SUBTYPE_PROMPT);

      if (payloads.length === 0 && prompts.length === 0) {
        return [];
      }

      const parts: string[] = [`// ${GENERATED_HEADER} — DO NOT EDIT.`];

      // Hoist the @metaobjectsdev/render import once (only when prompts emit handles).
      if (prompts.length > 0) {
        parts.push(RENDER_IMPORT);
      }

      // Emit payload interfaces with a single shared dedupe set so a lens
      // referenced by multiple payloads appears exactly once.
      const payloadInterfaces = generatePayloadInterfacesBatch(
        ctx.loadedRoot,
        payloads.map((p) => p.name),
      );
      if (payloadInterfaces.length > 0) {
        parts.push(payloadInterfaces);
      }

      // Append each render handle with its per-handle imports stripped — both
      // the now-hoisted render/Provider import and the standalone payloads.js
      // import. Also drop any leading blank lines left behind by the strip so
      // the joined output doesn't accumulate double blank gaps between parts.
      for (const t of prompts) {
        const lines = generateRenderHandle(ctx.loadedRoot, t.name)
          .split("\n")
          .filter((line) => line !== RENDER_IMPORT && !isStandalonePayloadImport(line));
        while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
        parts.push(lines.join("\n"));
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

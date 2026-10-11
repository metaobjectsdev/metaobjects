// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/trace-helper.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { traceHelperFile } from "./codegen/generators/trace-helper.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       the `ai` library's LLM-call trace. The emitted module calls
//                `@metaobjectsdev/runtime-ts` (ObjectManager, the trace row builders),
//                `@metaobjectsdev/render` (extract, render) and, for a renderable prompt,
//                `@metaobjectsdev/ai-runtime` (runLlmCall).
// use-when:      an entity extends a library's trace anchor (the `ai` library's
//                `LlmCallBase`) and nests a `template.prompt` with @payloadRef and
//                @responseRef, and you want a typed `record<Entity>` — plus `call<Entity>`
//                when the prompt carries @textRef — instead of hand-wiring extract +
//                buildLlmCallRow + persist at every call site.
// emits:         <target>/<Entity>.trace.ts per concrete trace entity whose nested prompt
//                names both value objects; nothing for an entity that does not.
// customize:     which entities get a helper (the two gates below), the output directory
//                (`outDir`) and the file name. The module BODY comes from
//                `renderTraceHelper`; to change the emitted code itself, copy
//                `renderTraceHelper`'s source out of the package and call your copy here
//                instead.
// composes-with: entity.ts (the helper is typed by the request and response value
//                objects' own interfaces, imported from the modules entity.ts emits).
//
// Everything below imports ONLY from `@metaobjectsdev/codegen-ts` (the stable engine).

import type { MetaData } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  extendsTraceAnchor,
  renderTraceHelper,
  traceAnchorNodes,
} from "@metaobjectsdev/codegen-ts";

export interface TraceHelperOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

export const traceHelperFile = function traceHelperFile(opts?: TraceHelperOpts): Generator {
  const dirPrefix = opts?.outDir ? `${opts.outDir.replace(/\/$/, "")}/` : "";
  // Resolved once per run, on first use: `perEntity` calls back per entity and the
  // anchor set is a property of the run, not of the entity.
  let anchors: MetaData[] | undefined;
  const generator: Generator = {
    name: "trace-helper",
    generate: perEntity((entity, ctx) => {
      anchors ??= traceAnchorNodes(ctx);
      // OWNED: only concrete entities derived from a library's declared anchor.
      if (entity.isAbstract) return [];
      if (!extendsTraceAnchor(entity, anchors)) return [];
      const path = `${dirPrefix}${entity.name}.trace.ts`;
      const content = renderTraceHelper(entity, ctx, path);
      return content === undefined ? [] : [{ path, content }];
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<TraceHelperOpts>;

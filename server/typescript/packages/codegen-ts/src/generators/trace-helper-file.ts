// server/typescript/packages/codegen-ts/src/generators/trace-helper-file.ts
//
// Stock generator that emits one <Entity>.trace.ts helper per trace entity. This file is
// the selection and the output path; what a trace entity IS, and the module body, live in
// templates/trace-helper.ts (anchor walk: `traceAnchorNodes` / `extendsTraceAnchor`;
// prompt gating and rendering: `renderTraceHelper`) — the same split the reference
// template `meta eject trace-helper` copies.
//
// Consumer wiring (metaobjects.config.ts):
//   generators: [..., entityFile(), queriesFile(), traceHelperFile(), barrel()]

import type { MetaData } from "@metaobjectsdev/metadata";
import { type Generator, type GeneratorFactory, perEntity } from "../generator.js";
import {
  TRACE_HELPER_STABLE_NAME,
  extendsTraceAnchor,
  renderTraceHelper,
  traceAnchorNodes,
} from "../templates/trace-helper.js";

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
    name: TRACE_HELPER_STABLE_NAME,
    generate: perEntity((entity, ctx) => {
      anchors ??= traceAnchorNodes(ctx);
      // Only concrete entities derived from a library's declared anchor.
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

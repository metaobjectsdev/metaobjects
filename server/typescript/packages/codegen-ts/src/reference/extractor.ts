// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/extractor.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { extractor } from "./codegen/generators/extractor.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       nothing framework-specific. The emitted module calls the tolerant extract
//                engine in `@metaobjectsdev/render` and the loader in `@metaobjectsdev/metadata`.
// use-when:      a responding `template.prompt` (one carrying @responseRef) should get a typed
//                `extract<Name>` helper that recovers a partial reply instead of rejecting it.
// emits:         <target>/<Prompt>.extractor.ts per responding template.prompt whose
//                @responseRef resolves to a value object.
// customize:     which prompts get an extractor, the output directory (`outDir`), the file
//                name. The module BODY comes from `renderExtractor`; to change the emitted
//                code itself, copy `renderExtractor`'s source out of the package and call
//                your copy here instead.
// composes-with: output-parser.ts (the extractor imports the parser module's lenient entry).
//
// Everything below imports ONLY from `@metaobjectsdev/codegen-ts` (the stable engine).

import {
  oncePerRun,
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  inboundTemplates,
  responseShape,
  renderExtractor,
} from "@metaobjectsdev/codegen-ts";

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
        if (!responseShape(ctx.loadedRoot, t)) continue;
        const path = `${dirPrefix}${t.name}.extractor.ts`;
        files.push({ path, content: renderExtractor(ctx.loadedRoot, t.name, ctx.renderContext, path) });
      }
      return files;
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<ExtractorOpts>;

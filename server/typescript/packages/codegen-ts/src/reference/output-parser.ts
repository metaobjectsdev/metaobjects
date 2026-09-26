// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/output-parser.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { outputParser } from "./codegen/generators/output-parser.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Zod for the strict tier. The emitted module imports `zod`, plus the
//                tolerant extract engine from `@metaobjectsdev/render` and the loader from
//                `@metaobjectsdev/metadata` / `@metaobjectsdev/runtime-ts`.
// use-when:      a `template.prompt` declares @responseRef and you want a typed
//                parse*/safeParse* (plus the tolerant extractLenient*) for the model's reply.
// emits:         <target>/<Prompt>.response.ts per responding template.prompt (one carrying
//                @responseRef). A `template.output` is outbound only and gets nothing (ADR-0052).
// customize:     which prompts get a parser, the output directory (`outDir`), the file name.
//                The module BODY comes from `renderOutputParser` — the parser the reply
//                contract is conformance-gated against — so to change the emitted code
//                itself, copy `renderOutputParser`'s source out of the package and call
//                your copy here instead.
// composes-with: entity.ts (the strict parse returns the response value object's interface).
//
// Everything below imports ONLY from `@metaobjectsdev/codegen-ts` (the stable engine).

import {
  oncePerRun,
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  inboundTemplates,
  renderOutputParser,
} from "@metaobjectsdev/codegen-ts";

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
      const files: EmittedFile[] = [];
      for (const t of inboundTemplates(ctx.loadedRoot)) {
        const path = `${dirPrefix}${t.name}.response.ts`;
        files.push({ path, content: renderOutputParser(ctx.loadedRoot, t.name, ctx.renderContext, path) });
      }
      return files;
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<OutputParserOpts>;

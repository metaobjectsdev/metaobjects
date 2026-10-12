// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/output-prompt.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { outputPrompt } from "./codegen/generators/output-prompt.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       nothing framework-specific. The emitted module calls `renderOutputFormat`
//                from `@metaobjectsdev/render`.
// use-when:      a responding `template.prompt` (one carrying @responseRef) should get the
//                "produce your answer like this" fragment to splice into its prompt text.
// emits:         <target>/<Prompt>.responseFormat.ts per responding template.prompt whose
//                @responseRef resolves, exporting render<Prompt>Format(overrides?).
// customize:     which prompts get a fragment, the output directory (`outDir`), the file
//                name. The module BODY comes from `renderOutputPrompt`, which `meta eject`
//                copies beside this file (`codegen/templates/output-prompt.ts`): change the
//                emitted code there.
// composes-with: output-parser.ts (the fragment describes the shape that parser accepts).
//
// Everything below imports the engine from `@metaobjectsdev/codegen-ts` (the generator base, the
// model walks, the naming and type-mapping tables) and the code that writes the output from
// `../templates/`. `meta eject` copies those template modules into your project, under
// `codegen/templates/`, and your copy of this file imports them from there: they are yours too.

import {
  oncePerRun,
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  inboundTemplates,
  responseShape,
} from "@metaobjectsdev/codegen-ts";
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
        if (!responseShape(root, t)) continue;
        files.push({ path: `${dirPrefix}${t.name}.responseFormat.ts`, content: renderOutputPrompt(root, t.name) });
      }
      return files;
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<OutputPromptOpts>;

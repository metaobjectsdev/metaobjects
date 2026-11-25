// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/prompt-render.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { promptRender } from "./codegen/generators/prompt-render.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       nothing framework-specific. The emitted file imports `render` + `Provider`
//                from `@metaobjectsdev/render` (the render ENGINE, which you do not own and
//                which stays byte-identical across ports) and each payload's own interface
//                from the module entity.ts emits for it.
// use-when:      you declare `template.prompt` nodes and want one typed
//                `render<Name>(payload, provider)` handle per prompt instead of calling
//                `render({ ref, ... })` with a loose payload by hand.
// emits:         <target>/prompts.ts — one render handle per template.prompt that carries a
//                resolvable @payloadRef. Nothing when the model declares no prompts.
// customize:     the handle's name and signature, the output file (`outFile`), extra
//                wrappers (a default provider, logging, a token budget check). What you own
//                is the HANDLE; the engine it calls, and the byte-identical rendering it
//                guarantees, stay in the package.
// composes-with: entity.ts (emits each payload value object's interface this file imports).
//
// Everything below imports the engine from `@metaobjectsdev/codegen-ts` (the generator base, the
// model walks, the naming tables), the node types from `@metaobjectsdev/metadata`, and the
// payload import lines from `../templates/`. `meta eject` copies that module into your project,
// under `codegen/templates/`, and your copy of this file imports it from there. The handle
// composition is inlined here so you own it.

import {
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_FORMAT,
  refTarget,
  type MetaData,
} from "@metaobjectsdev/metadata";
import {
  oncePerRun,
  type Generator,
  type GeneratorFactory,
  findTemplates,
  templateSymbolBase,
  GENERATED_HEADER,
  GENERATED_EDIT_NOTE,
  TsWriter,
} from "@metaobjectsdev/codegen-ts/engine";
import { derivePayloadFieldTree, fieldTreeLiteral } from "../templates/render-helper.js";
import { valueObjectImport } from "../templates/value-object-import.js";

export interface PromptRenderOpts {
  /** Output file path relative to the target's outDir. Default: "prompts.ts". */
  outFile?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

const RENDER_MODULE = "@metaobjectsdev/render";

// --- composition (OWNED) — one typed render handle per template.prompt. ---
function writeHandle(w: TsWriter, tmpl: MetaData, payloadType: string, payloadVo: MetaData): void {
  const render = w.use("render", RENDER_MODULE);
  const provider = w.useType("Provider", RENDER_MODULE);
  // Resolving accessors (ADR-0039): a template may inherit its refs/format via extends.
  const textRef = tmpl.attr(TEMPLATE_ATTR_TEXT_REF);
  const format = (tmpl.attr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text";
  const fn = `render${templateSymbolBase(tmpl.name)}`;
  // The payload field tree is baked in so render() checks the template it resolves at RUN time
  // against it: `{{nmae}}` for `name` raises ERR_VAR_NOT_ON_PAYLOAD instead of rendering empty.
  const verify = fieldTreeLiteral(derivePayloadFieldTree(payloadVo));
  w.blank().block(`export function ${fn}(payload: ${payloadType}, provider: ${provider}): string {`, () => {
    w.line(`return ${render}({ ref: ${JSON.stringify(textRef)}, payload, format: ${JSON.stringify(format)}, provider, verify: ${verify} });`);
  });
}

export const promptRender = function promptRender(opts?: PromptRenderOpts): Generator {
  const outFile = opts?.outFile ?? "prompts.ts";
  const generator: Generator = {
    name: "prompt-render",
    generate: oncePerRun((_entities, ctx) => {
      const prompts = findTemplates(ctx.loadedRoot, TEMPLATE_SUBTYPE_PROMPT);
      const w = new TsWriter();
      w.header(`// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`);
      let handles = 0;
      for (const t of prompts) {
        const ref = t.attr(TEMPLATE_ATTR_PAYLOAD_REF);
        if (typeof ref !== "string" || ref === "") continue;
        // ADR-0059 R7: the value object the loader bound for @payloadRef.
        const vo = refTarget(t, TEMPLATE_ATTR_PAYLOAD_REF);
        if (vo === undefined) continue;
        const imp = valueObjectImport(ctx.renderContext, vo, outFile, ctx.config.extStyle ?? "js");
        // The payload value object's own interface, imported type-only under its local name.
        writeHandle(w, t, w.useType(imp.exported, imp.specifier, imp.name), vo);
        handles++;
      }
      if (handles === 0) return [];

      const content = w.toString();
      return [{ path: outFile, content }];
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<PromptRenderOpts>;

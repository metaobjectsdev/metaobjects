// Stock generator that emits ONE file of typed render handles — one
// `render<Name>(payload, provider)` per template.prompt — over the render() engine.
//
// ADR-0056: the handles take each prompt's @payloadRef value object's OWN interface, which
// entityFile() declares in the value object's module, and import it from there. This file
// declares no payload interface of its own (it used to re-declare every object.value, a second
// copy of each shape). Wire entityFile() in the same run, or the imports point at nothing.
//
// Consumer wiring (metaobjects.config.ts):
//   generators: [..., entityFile(), promptRender()]
//
// Custom output path:
//   generators: [..., promptRender({ outFile: "src/render/generated/prompts.ts" })]

import {
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_FORMAT,
  refTarget,
  type MetaData,
} from "@metaobjectsdev/metadata";
import { findTemplates } from "../templates/find-templates.js";
import {
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
import { templateSymbolBase } from "../naming.js";
import { derivePayloadFieldTree, fieldTreeLiteral } from "../templates/render-helper.js";
import { useValueObjectType, valueObjectImport } from "../templates/value-object-import.js";
import { TsWriter } from "../writer/ts-writer.js";
import { GENERATED_HEADER, GENERATED_EDIT_NOTE } from "../constants.js";

export interface PromptRenderOpts {
  /** Output file path relative to the target's outDir. Default: "prompts.ts". */
  outFile?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

const RENDER_MODULE = "@metaobjectsdev/render";

/** One template.prompt's typed render handle, typed by its payload's own interface. */
function writeHandle(w: TsWriter, tmpl: MetaData, payloadType: string, payloadVo: MetaData): void {
  const render = w.use("render", RENDER_MODULE);
  const provider = w.useType("Provider", RENDER_MODULE);
  // ADR-0039: resolving — a template may inherit its @* refs/format via extends.
  const textRef = tmpl.attr(TEMPLATE_ATTR_TEXT_REF);
  const format = (tmpl.attr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text";
  // One base for every symbol a template emits, shared with the parser and render helper.
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
        // ADR-0039: resolving — a template may inherit @payloadRef via extends.
        const ref = t.attr(TEMPLATE_ATTR_PAYLOAD_REF);
        if (typeof ref !== "string" || ref === "") continue;
        // ADR-0059 R7: the value object the loader bound for @payloadRef. The loader has
        // already enforced the legal target set (object.value / sourceless projection, #210).
        const vo = refTarget(t, TEMPLATE_ATTR_PAYLOAD_REF);
        if (vo === undefined) continue;
        const imp = valueObjectImport(ctx.renderContext, vo, outFile, ctx.config.extStyle ?? "js");
        writeHandle(w, t, useValueObjectType(w, imp), vo);
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

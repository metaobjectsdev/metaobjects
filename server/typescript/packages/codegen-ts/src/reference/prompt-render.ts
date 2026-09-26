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
// Everything below imports ONLY from `@metaobjectsdev/codegen-ts` (the stable engine) and
// `@metaobjectsdev/metadata`. The handle composition is inlined here so you own it.

import {
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_FORMAT,
  resolveObjectRef,
  type MetaData,
} from "@metaobjectsdev/metadata";
import {
  oncePerRun,
  type Generator,
  type GeneratorFactory,
  findTemplates,
  templateSymbolBase,
  valueObjectImport,
  valueObjectImportLines,
  type ValueObjectImport,
  GENERATED_HEADER,
} from "@metaobjectsdev/codegen-ts";

export interface PromptRenderOpts {
  /** Output file path relative to the target's outDir. Default: "prompts.ts". */
  outFile?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

const RENDER_IMPORT = `import { render, type Provider } from "@metaobjectsdev/render";`;

// --- composition (OWNED) — one typed render handle per template.prompt. ---
function renderHandle(tmpl: MetaData, payloadType: string): string {
  // Resolving accessors (ADR-0039): a template may inherit its refs/format via extends.
  const textRef = tmpl.attr(TEMPLATE_ATTR_TEXT_REF);
  const format = (tmpl.attr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text";
  const fn = `render${templateSymbolBase(tmpl.name)}`;
  return [
    `export function ${fn}(payload: ${payloadType}, provider: Provider): string {`,
    `  return render({ ref: ${JSON.stringify(textRef)}, payload, format: ${JSON.stringify(format)}, provider });`,
    `}`,
  ].join("\n");
}

export const promptRender = function promptRender(opts?: PromptRenderOpts): Generator {
  const outFile = opts?.outFile ?? "prompts.ts";
  const generator: Generator = {
    name: "prompt-render",
    generate: oncePerRun((_entities, ctx) => {
      const prompts = findTemplates(ctx.loadedRoot, TEMPLATE_SUBTYPE_PROMPT);
      const imports: ValueObjectImport[] = [];
      const handles: string[] = [];
      for (const t of prompts) {
        const ref = t.attr(TEMPLATE_ATTR_PAYLOAD_REF);
        if (typeof ref !== "string" || ref === "") continue;
        // A bare ref resolves in the template's own package first (ADR-0042).
        const vo = resolveObjectRef(ctx.loadedRoot, ref, t.package ?? t.fileDefaultPackage ?? "").node;
        if (vo === undefined) continue;
        const imp = valueObjectImport(ctx.renderContext, vo, outFile, ctx.config.extStyle ?? "js");
        imports.push(imp);
        handles.push(renderHandle(t, imp.name));
      }
      if (handles.length === 0) return [];

      const content = [
        `// ${GENERATED_HEADER} — DO NOT EDIT.`,
        "",
        RENDER_IMPORT,
        ...valueObjectImportLines(imports),
        "",
        handles.join("\n\n"),
        "",
      ].join("\n");
      return [{ path: outFile, content }];
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<PromptRenderOpts>;

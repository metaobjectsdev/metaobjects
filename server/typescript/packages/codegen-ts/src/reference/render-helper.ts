// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/render-helper.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { renderHelper } from "./codegen/generators/render-helper.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       nothing framework-specific. The emitted module calls `render` from
//                `@metaobjectsdev/render`; an email helper returns its `EmailDocument` shape.
// use-when:      you declare `template.output` nodes (documents or emails) and want a typed
//                render helper per template, with the build failing when a referenced
//                Mustache file names a field the payload does not have.
// emits:         <target>/<Template>.render.ts per template.output whose @payloadRef
//                resolves. Resolves each referenced Mustache file from the project's
//                `templates/` directory at gen time and runs the drift gate on it.
// customize:     which templates get a helper, the output directory (`outDir`), where the
//                gen-time Mustache files come from (the `provider`). The module BODY and the
//                drift gate come from `renderRenderHelper`; to change the emitted code
//                itself, copy its source out of the package and call your copy here instead.
// composes-with: entity.ts (the helper takes the payload value object's interface).
//
// Everything below imports ONLY from `@metaobjectsdev/codegen-ts` (the stable engine) and
// `@metaobjectsdev/metadata`.

import {
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";
import {
  oncePerRun,
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  projectProvider,
  renderRenderHelper,
} from "@metaobjectsdev/codegen-ts";

export interface RenderHelperOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

export const renderHelper = function renderHelper(opts?: RenderHelperOpts): Generator {
  const dirPrefix = opts?.outDir ? `${opts.outDir.replace(/\/$/, "")}/` : "";
  const generator: Generator = {
    name: "render-helper",
    generate: oncePerRun((_entities, ctx) => {
      const root = ctx.loadedRoot;
      // Project `templates/` first, the package's shipped defaults after.
      const provider = projectProvider(ctx.projectRoot);
      const outputs = root
        .children()
        .filter((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_OUTPUT);
      const files: EmittedFile[] = [];
      for (const t of outputs) {
        const payloadRef = t.attr(TEMPLATE_ATTR_PAYLOAD_REF);
        if (typeof payloadRef !== "string") continue;
        const vo = resolveObjectRef(root, payloadRef, t.package ?? t.fileDefaultPackage ?? "").node;
        if (!vo) continue;
        const path = `${dirPrefix}${t.name}.render.ts`;
        files.push({
          path,
          content: renderRenderHelper(root, t.name, provider, ctx.config.extStyle ?? "js", ctx.renderContext, path),
        });
      }
      return files;
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<RenderHelperOpts>;

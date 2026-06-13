// server/typescript/packages/codegen-ts/src/generators/render-helper-file.ts
//
// Stock generator that emits one `<TemplateName>.render.ts` typed render helper
// per `template.output` node — `render<Name>(payload, provider)` wrapping the
// render() engine (document → string, email → EmailDocument). The mustache↔VO
// drift check (the render lib's verify()) is enforced at BUILD time: this
// generator resolves each referenced mustache through the codegen-time provider
// (projectProvider(ctx.projectRoot)) and FAILS codegen when a `{{field}}` isn't
// on the payload VO. Skips template.output nodes whose @payloadRef doesn't
// resolve to a value-object (same contract as the prompt/parser generators).
//
// Consumer wiring (metaobjects.config.ts):
//   generators: [..., renderHelper()]
//
// Custom output directory:
//   generators: [..., renderHelper({ outDir: "src/generated/render" })]

import {
  TYPE_OBJECT,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  refMatchesObject,
} from "@metaobjectsdev/metadata";
import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
import { projectProvider } from "../render-engine/framework-provider.js";
import { renderRenderHelper } from "../templates/render-helper.js";

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
      // The codegen-time provider — layers the project's templates/ dir over the
      // framework defaults; used to resolve + verify each referenced mustache so
      // the build-time drift gate runs against the same texts render() will see.
      const provider = projectProvider(ctx.projectRoot);
      const outputs = root
        .ownChildren()
        .filter((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_OUTPUT);
      const files: EmittedFile[] = [];
      for (const t of outputs) {
        // @payloadRef must resolve to a value-object (same contract as the parser).
        const payloadRef = t.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
        if (typeof payloadRef !== "string") continue;
        const vo = root.ownChildren().find((c) => c.type === TYPE_OBJECT && refMatchesObject(c, payloadRef));
        if (!vo) continue;
        files.push({
          // renderRenderHelper THROWS (fails codegen) on a mustache↔VO drift —
          // intentionally NOT caught: a drifted template is a build error.
          path: `${dirPrefix}${t.name}.render.ts`,
          content: renderRenderHelper(root, t.name, provider),
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

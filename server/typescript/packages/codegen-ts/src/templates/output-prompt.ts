// server/typescript/packages/codegen-ts/src/templates/output-prompt.ts
//
// Per-template renderer for the FR-010 artifact-1 response-format fragment
// ("produce your answer like this"). For each `template.prompt` whose @responseRef
// resolves to a value-object, emits a `<PromptName>.responseFormat.ts` file
// exporting `render<PromptName>Format(overrides?)` backed by the render engine's
// renderOutputFormat(). The baked OutputFormatSpec's rootName is the RESPONSE VO's
// name, so the fragment and the extract() codegen agree on the root name.
//
// Mirrors the C# OutputPromptGenerator + OutputFormatSpecEmitter (split into a
// generator factory + this pure renderer, matching the TS output-parser shape).

import {
  type MetaData,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_ATTR_RESPONSE_REF,
} from "@metaobjectsdev/metadata";
import { specLiteral } from "./output-format-spec-emitter.js";
import { responseShape } from "./find-inbound.js";

// ADR-0039: resolving — root has no super (children()==ownChildren()); a top-level object/template may itself extend, so resolve rather than work-by-accident.
function findTemplate(root: MetaData, name: string): MetaData | undefined {
  return root.children().find((c) => c.type === TYPE_TEMPLATE && c.name === name);
}

/**
 * Render the full response-format fragment file for one responding
 * `template.prompt`. Throws if the template isn't found, isn't a template.prompt,
 * or its @responseRef is missing / doesn't resolve to an object.value.
 *
 * ADR-0052: the fragment describes the shape named by `@responseRef` — the reply —
 * not `@payloadRef`, which is the request this prompt renders outbound.
 */
export function renderOutputPrompt(root: MetaData, templateName: string): string {
  const tmpl = findTemplate(root, templateName);
  if (!tmpl) {
    throw new Error(`template "${templateName}" not found in metadata root`);
  }
  if (tmpl.subType !== TEMPLATE_SUBTYPE_PROMPT) {
    throw new Error(`template "${templateName}" is not a template.prompt (got subtype "${tmpl.subType}")`);
  }
  const shape = responseShape(root, tmpl);
  if (!shape) {
    // ADR-0039: resolving — @responseRef may be inherited via extends.
    const declared = tmpl.attr(TEMPLATE_ATTR_RESPONSE_REF);
    throw new Error(
      typeof declared === "string"
        ? `template "${templateName}" @responseRef "${declared}" not found in metadata root`
        : `template "${templateName}" missing @responseRef`,
    );
  }
  const { vo, ref: payloadRef } = shape;

  // rootName == response VO name so the fragment and extract() agree.
  const spec = specLiteral(vo, tmpl, payloadRef);
  const specName = `${templateName}FormatSpec`;
  const fnName = `render${templateName}Format`;

  return `import {
  renderOutputFormat,
  Format,
  FieldKind,
  PromptStyle,
  type OutputFormatSpec,
  type PromptOverrides,
} from "@metaobjectsdev/render";

const ${specName}: OutputFormatSpec = ${spec};

/**
 * The response-format instruction fragment for the ${templateName} template.prompt
 * ("produce your answer like this"). Comment-free — guidance lives in prose /
 * inline placeholders / a filled skeleton. Pass \`overrides\` to override the style
 * or per-field example/instruction at render time.
 */
export function ${fnName}(overrides?: PromptOverrides): string {
  return renderOutputFormat(${specName}, overrides ?? {});
}
`;
}

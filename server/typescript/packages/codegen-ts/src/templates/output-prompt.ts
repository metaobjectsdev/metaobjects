// server/typescript/packages/codegen-ts/src/templates/output-prompt.ts
//
// Per-template renderer for the FR-010 artifact-1 output-format prompt fragment
// ("produce your answer like this"). For each json/xml `template.output` whose
// @payloadRef resolves to a value-object, emits a `<TemplateName>.prompt.ts` file
// exporting `render<TemplateName>Format(overrides?)` backed by the render engine's
// renderOutputFormat(). The baked OutputFormatSpec's rootName is the payload name,
// so the prompt fragment and the extract() codegen agree on the root name.
//
// Mirrors the C# OutputPromptGenerator + OutputFormatSpecEmitter (split into a
// generator factory + this pure renderer, matching the TS output-parser shape).

import {
  type MetaData,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_FORMAT,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";
import { specLiteral } from "./output-format-spec-emitter.js";

// ADR-0039: resolving — root has no super (children()==ownChildren()); a top-level object/template may itself extend, so resolve rather than work-by-accident.
// ADR-0042: resolveObjectRef gives package-local-before-root-level precedence for a bare ref, FQN-exact otherwise.
function findObject(root: MetaData, name: string, referrerPkg = ""): MetaData | undefined {
  return resolveObjectRef(root, name, referrerPkg).node;
}

// ADR-0039: resolving — root has no super (children()==ownChildren()); a top-level object/template may itself extend, so resolve rather than work-by-accident.
function findTemplate(root: MetaData, name: string): MetaData | undefined {
  return root.children().find((c) => c.type === TYPE_TEMPLATE && c.name === name);
}

/** True iff the template.output's @format is json or xml (the renderable structured formats). */
export function templateSupportsPrompt(tmpl: MetaData): boolean {
  // ADR-0039: resolving — a template may inherit its @* refs/format/kind via extends.
  const f = ((tmpl.attr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text").toLowerCase();
  return f === "json" || f === "xml";
}

/**
 * Render the full output-prompt file for one json/xml `template.output` node.
 * Throws if the template isn't found, isn't a template.output, isn't json/xml,
 * or its @payloadRef doesn't resolve to an object.value.
 */
export function renderOutputPrompt(root: MetaData, templateName: string): string {
  const tmpl = findTemplate(root, templateName);
  if (!tmpl) {
    throw new Error(`template "${templateName}" not found in metadata root`);
  }
  if (tmpl.subType !== TEMPLATE_SUBTYPE_OUTPUT) {
    throw new Error(`template "${templateName}" is not a template.output (got subtype "${tmpl.subType}")`);
  }
  if (!templateSupportsPrompt(tmpl)) {
    throw new Error(`template "${templateName}" @format is not json/xml — no prompt fragment`);
  }
  // ADR-0039: resolving — a template may inherit its @* refs/format/kind via extends.
  const payloadRef = tmpl.attr(TEMPLATE_ATTR_PAYLOAD_REF);
  if (typeof payloadRef !== "string") {
    throw new Error(`template "${templateName}" missing @payloadRef`);
  }
  // ADR-0042: a bare @payloadRef resolves in the template's package.
  const vo = findObject(root, payloadRef, tmpl.package ?? tmpl.fileDefaultPackage ?? "");
  if (!vo) {
    throw new Error(`template "${templateName}" @payloadRef "${payloadRef}" not found in metadata root`);
  }

  // rootName == payload name so the prompt fragment and extract() agree.
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
 * The output-format instruction fragment for the ${templateName} template.output
 * ("produce your answer like this"). Comment-free — guidance lives in prose /
 * inline placeholders / a filled skeleton. Pass \`overrides\` to override the style
 * or per-field example/instruction at render time.
 */
export function ${fnName}(overrides?: PromptOverrides): string {
  return renderOutputFormat(${specName}, overrides ?? {});
}
`;
}

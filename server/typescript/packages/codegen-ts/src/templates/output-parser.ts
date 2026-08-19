// server/typescript/packages/codegen-ts/src/templates/output-parser.ts
//
// Per-template renderer for template.output codegen. Walks the @payloadRef's
// value-object into a Zod schema and emits a dual-API parser (parse + safeParse)
// alongside the schema, plus (for json/xml outputs) a single tolerant
// loader-delegating `extractLenient<Name>WithLoader(root, text)` that delegates to
// the metadata-driven runtime extract. The emitted file derives a local data type
// via `z.infer<typeof Schema>` and exports it as `<TemplateName>Data`. Consumers
// wiring `promptRender()` get a structurally identical payload-VO interface in
// `prompts.ts`; either type can be used interchangeably with parse results.

import {
  type MetaData,
  TYPE_FIELD,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_PROMPT,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  TEMPLATE_ATTR_RESPONSE_REF,
  RESPONSE_FORMAT_XML,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";
import { responseShape } from "./find-inbound.js";
import { isRequired } from "./fr010-field-mapping.js";
import {
  nestedMirrorInterfaces,
  nestedMappers,
  rootMapperName,
  delegateHelpers,
  usedHelpers,
  hasNested,
} from "./extract-delegate-emitter.js";
import type { RenderContext } from "../render-context.js";

const SCALAR_ZOD: Record<string, string> = {
  string: "z.string()",
  class: "z.string()",
  int: "z.number().int()",
  short: "z.number().int()",
  byte: "z.number().int()",
  long: "z.number().int()",
  double: "z.number()",
  float: "z.number()",
  boolean: "z.boolean()",
};

// ADR-0039: resolving — root has no super (children()==ownChildren()); a top-level object/template may itself extend, so resolve rather than work-by-accident.
// ADR-0042: resolveObjectRef gives package-local-before-root-level precedence for a bare ref, FQN-exact otherwise.
function findObject(root: MetaData, name: string, referrerPkg = ""): MetaData | undefined {
  return resolveObjectRef(root, name, referrerPkg).node;
}

// ADR-0039: resolving — root has no super (children()==ownChildren()); a top-level object/template may itself extend, so resolve rather than work-by-accident.
function findTemplate(root: MetaData, name: string): MetaData | undefined {
  return root.children().find((c) => c.type === TYPE_TEMPLATE && c.name === name);
}

/** Render the Zod expression for a single field; recurses on @objectRef.
 *
 * Optionality comes from `@required`, via the SAME `isRequired` predicate the
 * tolerant tier uses — so the two tiers in this file cannot disagree about what
 * the contract is. They used to: this schema emitted every field as mandatory
 * and never read `@required`, so `parse<Name>` threw on a reply that correctly
 * omitted a declared-optional field, while the tolerant extract accepted it.
 *
 * Every other port reuses the payload VO, which #309 made `@required`-correct.
 * TypeScript re-derives its schema inline here, which is how it drifted — the
 * same "payload tier disagrees with the rest of the toolchain" shape ADR-0052
 * came out of.
 */
function fieldZod(field: MetaData, root: MetaData, seen: ReadonlySet<string>, depth: number): string {
  // isArray is a native (reserved) property on MetaData, not an attr.
  const isArray = field.resolvedIsArray();
  let base: string;
  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    const refName = field.attr(FIELD_ATTR_OBJECT_REF);
    if (typeof refName !== "string") {
      base = "z.unknown()";
    } else if (seen.has(refName)) {
      // Cycle guard — emit unknown for self-references (rare; lazy schemas not in scope for v1).
      base = "z.unknown()";
    } else {
      // ADR-0042: a bare nested @objectRef resolves in the declaring VO's package.
      const inner = findObject(root, refName, field.parent?.package ?? field.parent?.fileDefaultPackage ?? "");
      base = inner ? renderObjectSchema(inner, root, new Set(seen).add(refName), depth + 1) : "z.unknown()";
    }
  } else {
    base = SCALAR_ZOD[field.subType] ?? "z.unknown()";
  }
  const shaped = isArray ? `z.array(${base})` : base;
  // `.optional()` wraps the ARRAY, not its element: an absent list and a list of
  // absent things are different claims.
  return isRequired(field) ? shaped : `${shaped}.optional()`;
}

/** Render a `z.object({ ... })` for an object.value node.
 *  At depth 0 the schema starts at column 0 (consumer's `const Foo = z.object({`),
 *  so fields sit at 2 spaces and the closing `})` at 0 spaces — matching the
 *  surrounding `const NameSchema = ...` statement's indent. Nested schemas
 *  step in two spaces per depth level. */
function renderObjectSchema(vo: MetaData, root: MetaData, seen: ReadonlySet<string>, depth: number): string {
  const fields = vo.children().filter((c) => c.type === TYPE_FIELD);
  const fieldIndent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  const lines = fields.map((f) => `${fieldIndent}${f.name}: ${fieldZod(f, root, seen, depth)},`);
  return `z.object({\n${lines.join("\n")}\n${closeIndent}})`;
}

/**
 * Render the full response-parser file for one responding `template.prompt`.
 * Throws if the template isn't found, isn't a template.prompt, or its
 * @responseRef is missing / doesn't resolve to an object.value.
 *
 * ADR-0052: the shape parsed INTO is `@responseRef`, not `@payloadRef` —
 * `@payloadRef` types the REQUEST rendered outbound, which is the distinction the
 * trace helper has always drawn ("@responseRef types the result; @payloadRef types
 * the request") and the inbound tier used to ignore.
 */
export function renderOutputParser(root: MetaData, templateName: string, ctx?: RenderContext): string {
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

  const schema = renderObjectSchema(vo, root, new Set([payloadRef]), 0);
  const schemaName = `${templateName}Schema`;
  const dataName = `${templateName}Data`;
  const errorName = `${templateName}ValidationError`;
  const parseName = `parse${templateName}`;
  const safeParseName = `safeParse${templateName}`;

  // FR-010: emit the tolerant extract() API alongside the strict Zod parser.
  //
  // ADR-0052/0053: a declared @responseRef ALWAYS gets the tolerant path, and the
  // syntax comes from @responseFormat (json|xml, default json) — never from
  // @format, which is the syntax of the rendered prompt BODY. The old json/xml
  // gate on @format is what made a text-bodied prompt with a JSON reply emit a
  // strict parser and no extract at all.
  const format = shape.format;

  // The strict Zod tier is JSON-ONLY, by construction.
  //
  // Its body is `Schema.parse(JSON.parse(text))`. There is no XML equivalent: the
  // TS runtime ships no XML parser, which is exactly why this reached for
  // JSON.parse in the first place — and it did so for an XML template too, so
  // `parse<Name>` was a generated function that could never work. Supplying one
  // would mean taking an XML-parser dependency AND assuming a model emits exactly
  // well-formed XML, which is the assumption FR-010's tolerant extract exists
  // because you cannot make.
  //
  // So an XML reply gets the tolerant extract and nothing else. Its typed shape is
  // `<Name>Extracted` — a nullable mirror, which is the honest type for a
  // best-effort parse of model output.
  const emitStrict = format !== RESPONSE_FORMAT_XML;

  const strictBody = `const ${schemaName} = ${schema};

export type ${dataName} = z.infer<typeof ${schemaName}>;
export type ${errorName} = z.ZodError;

/**
 * Parse an LLM response into a typed ${dataName}.
 * @throws ZodError on validation failure.
 */
export function ${parseName}(text: string): ${dataName} {
  return ${schemaName}.parse(JSON.parse(text));
}

/**
 * Parse an LLM response with explicit error handling (Result-style).
 * Does not throw on validation failure.
 */
export function ${safeParseName}(
  text: string,
): { success: true; data: ${dataName} } | { success: false; error: ${errorName} } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      success: false,
      error: new z.ZodError([{ code: "custom", path: [], message: \`invalid JSON: \${(err as Error).message}\` }]),
    };
  }
  const result = ${schemaName}.safeParse(parsed);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}
`;

  // ---- FR-010 tolerant extract block ----
  // Unconditional since ADR-0052: a declared @responseRef IS the request for the
  // tolerant path, and @responseFormat is a closed json|xml set, so there is no
  // longer a third case to gate on.
  const extractedName = `${templateName}Extracted`;
  const extractLenientWithName = `extractLenient${templateName}WithLoader`;
  const payloadFqnConst = `${templateName.toUpperCase()}_PAYLOAD_NAME`;
  const formatEnum = format === RESPONSE_FORMAT_XML ? "Format.XML" : "Format.JSON";

  // The nullable mirror is the return shape of the delegating extract. Use the nested-aware
  // emitter so the payload mirror's nested-object / array-of-object components are typed (not
  // `unknown`), and so a mirror interface is emitted for every reachable nested value-object.
  // The payload mirror keeps the canonical `<Template>Extracted` name. ADR-0044/#228: `ctx`
  // qualifies a nested mirror's name/dedupe when its VO's bare short name collides across
  // packages, matching Task 3's entity-domain emitted name (e.g. `AcmeAlphaNoteExtracted`).
  const mirrorDecls = nestedMirrorInterfaces(vo, root, extractedName, ctx);

  // Render-package imports the (single, loader-delegating) extract block needs. Kept minimal so
  // the file has no unused imports (tsc noUnusedLocals-safe).
  const renderImports = ["Format", "type ExtractOptions", "type ExtractionResult"];

  // ---- Runtime-delegating extract (the single metadata-driven extract path) ----
  // Resolves this payload's MetaObject from a loaded MetaRoot by its baked simple name and
  // delegates to extractObject() in @metaobjectsdev/runtime-ts, which assembles the FULL nested
  // object graph reflection-free by reading the live metadata directly. The assembled ValueObject
  // graph is then mapped into the typed nullable mirror graph by the generated from<VO>Extracted
  // mappers. Codegen-wrapping-runtime (a generated DAO calling the dynamic-metadata runtime).
  //
  // The baked PAYLOAD_NAME is normally the resolved payload VO's SIMPLE name (root.findObject
  // matches on the object's `name`, not its FQN). The root mapper is named for the TEMPLATE (so
  // it returns the canonically-named `<Template>Extracted` mirror); nested mappers use their VO
  // names (via the entity-domain name map, so they agree with the imported mirror types above).
  //
  // ADR-0044/#228 — `root.findObject()` (MetaRoot's public runtime API) is a BARE-name-only,
  // first-match lookup with no package awareness. If THIS PAYLOAD's own bare name collides with
  // a same-short-name value-object elsewhere in the run (the identical signal Option A already
  // computes: `ctx.valueObjectEmittedName(vo)` diverges from the bare name), a bare lookup could
  // silently resolve to the WRONG package's object at runtime (load-order-dependent — the exact
  // hazard class ADR-0042 closed everywhere else). When it does collide, bake the FQN
  // (`resolutionKey()`) instead and resolve it via the SAME canonical ADR-0042 `resolveObjectRef`
  // this file's own build-time `findObject()` wraps (FQN-exact, load-order-independent). A
  // non-colliding payload keeps the bare name + `root.findObject()` path — byte-identical to
  // pre-#228 output.
  const payloadName = vo.name;
  const emittedPayloadName = ctx ? ctx.valueObjectEmittedName(vo) : payloadName;
  const payloadNameCollides = emittedPayloadName !== payloadName;
  const bakedPayloadName = payloadNameCollides ? vo.resolutionKey() : payloadName;
  const rootMapper = rootMapperName(templateName);
  void hasNested;
  const lookupExpr = payloadNameCollides
    ? `resolveObjectRef(root, ${payloadFqnConst}, "").node`
    : `root.findObject(${payloadFqnConst})`;
  const delegating = `
/** Payload value-object name this parser extracts — resolved against a loaded MetaRoot at runtime.${
    payloadNameCollides
      ? " ADR-0042 FQN (this payload's bare name collides with a same-short-name value object elsewhere in the run)."
      : ""
  } */
export const ${payloadFqnConst} = ${JSON.stringify(bakedPayloadName)};

${mirrorDecls}

${nestedMappers(vo, root, rootMapper, extractedName, ctx)}

${delegateHelpers(usedHelpers(vo, root))}

/**
 * Runtime-delegating tolerant best-effort extraction; never throws. FULLY populates
 * nested-object and array-of-object components by delegating to the metadata-driven runtime
 * \`extractObject\` (which assembles the whole graph reflection-free via the Phase A object
 * model, reading the live metadata directly), then maps the assembled graph into the typed
 * \`${extractedName}\` mirror.
 *
 * @param root a loaded MetaRoot (e.g. \`(await new MetaDataLoader().load(...)).root\`) that declares
 *             the \`${payloadName}\` value-object.
 */
export function ${extractLenientWithName}(
  root: MetaRoot,
  text: string,
  opts?: Partial<ExtractOptions> | null,
): ExtractionResult<${extractedName}> {
  const mo = ${lookupExpr};
  if (mo === undefined) {
    throw new Error(\`${extractLenientWithName}: payload "\${${payloadFqnConst}}" not found in the supplied MetaRoot\`);
  }
  const outcome = extractObject(mo, text, ${formatEnum}, opts);
  return { data: ${rootMapper}(outcome.data), report: outcome.report };
}
`;

  // The delegating overload needs runtime-ts (extractObject) + the MetaRoot type from metadata
  // (+ resolveObjectRef, ADR-0044/#228, only when this payload's own bare name collides).
  const metadataImport = payloadNameCollides
    ? `import type { MetaRoot } from "@metaobjectsdev/metadata";\nimport { resolveObjectRef } from "@metaobjectsdev/metadata";\n`
    : `import type { MetaRoot } from "@metaobjectsdev/metadata";\n`;
  const runtimeImport = `import { extractObject } from "@metaobjectsdev/runtime-ts";\n`;

  // `zod` is imported only when the strict tier is emitted — an XML reply's file
  // would otherwise carry an unused import (tsc noUnusedLocals-unsafe).
  return (
    (emitStrict ? `import { z } from "zod";\n` : "") +
    `import {\n  ${renderImports.join(",\n  ")},\n} from "@metaobjectsdev/render";\n` +
    metadataImport +
    runtimeImport +
    `\n` +
    (emitStrict ? `${strictBody}\n` : "") +
    `${delegating}`
  );
}

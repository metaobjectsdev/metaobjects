// server/typescript/packages/codegen-ts/src/generators/trace-helper-file.ts
//
// Stock generator that emits one <Entity>.trace.ts helper file for each concrete
// entity that (a) extends LlmCallBase (directly or transitively) and (b) nests a
// template.prompt with @payloadRef and/or @responseRef.
//
// The emitted helper exports an async function `record<Entity>(om, responseMo, input)`
// that calls `recordLlmCall` from @metaobjectsdev/runtime-ts.  The helper is typed
// against the generated payload interfaces (request + response VOs) so call-sites
// get compile-time checks.
//
// NOTE: ObjectManager does not expose its loaded metadata root, so the caller must
// pass the resolved `responseMo: MetaObject` explicitly.  The generated helper
// documents this in its JSDoc.
//
// Consumer wiring (metaobjects.config.ts):
//   generators: [..., entityFile(), queriesFile(), traceHelperFile(), barrel()]

import {
  TYPE_OBJECT,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_RESPONSE_REF,
} from "@metaobjectsdev/metadata";
import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  perEntity,
} from "../generator.js";
import { generatePayloadInterfacesBatch } from "../payload-codegen.js";
import { GENERATED_HEADER } from "../constants.js";

export interface TraceHelperOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

const LLM_CALL_BASE = "LlmCallBase";

/** Walk the super chain looking for a node whose name matches `baseName`. */
function extendsBase(obj: MetaObject): boolean {
  let cur = obj.superResolved;
  while (cur !== undefined) {
    if (cur.name === LLM_CALL_BASE) return true;
    cur = cur.superResolved;
  }
  return false;
}

/** Capitalise the first character. */
function pascal(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export const traceHelperFile = function traceHelperFile(opts?: TraceHelperOpts): Generator {
  const dirPrefix = opts?.outDir ? `${opts.outDir.replace(/\/$/, "")}/` : "";
  const generator: Generator = {
    name: "trace-helper",
    generate: perEntity((entity, ctx) => {
      // Only concrete entities derived from LlmCallBase.
      if (entity.isAbstract) return [];
      if (!extendsBase(entity)) return [];

      // Find the nested template.prompt.
      const prompt = entity.ownChildren().find(
        (c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_PROMPT,
      );
      if (prompt === undefined) return [];

      const payloadRef = prompt.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
      const responseRef = prompt.ownAttr(TEMPLATE_ATTR_RESPONSE_REF);

      // Need at least @responseRef to type the result; @payloadRef types the request.
      if (typeof responseRef !== "string") return [];

      const entityName = entity.name;
      const fnName = `record${pascal(entityName)}`;

      // Collect VO names for interface emission (dedupe via batch emitter).
      const voNames: string[] = [];
      if (typeof payloadRef === "string") voNames.push(payloadRef);
      voNames.push(responseRef);

      // Emit the shared payload interfaces inline (same approach as prompt-render-file).
      const interfaces = generatePayloadInterfacesBatch(ctx.loadedRoot, voNames);

      const requestType = typeof payloadRef === "string" ? payloadRef : "unknown";

      const lines: string[] = [
        `// ${GENERATED_HEADER} — DO NOT EDIT.`,
        ``,
        `import type { ObjectManager } from "@metaobjectsdev/runtime-ts";`,
        `import {`,
        `  LlmCallDbRecorder,`,
        `  recordLlmCall,`,
        `  type LlmCallInput,`,
        `  type RecordLlmCallResult,`,
        `} from "@metaobjectsdev/runtime-ts";`,
        `import { Format } from "@metaobjectsdev/runtime-ts";`,
        `import type { MetaObject } from "@metaobjectsdev/metadata";`,
        ``,
        `// ---- Payload interfaces (inlined) ------------------------------------------`,
        ``,
        interfaces.trimEnd(),
        ``,
        `// ---- Typed result -----------------------------------------------------------`,
        ``,
        `export interface ${entityName}TraceResult extends RecordLlmCallResult {`,
        `  /** Parsed response VO, or null when extraction reported a lost-required field. */`,
        `  voResponse: ${responseRef} | null;`,
        `}`,
        ``,
        `// ---- Record helper ----------------------------------------------------------`,
        ``,
        `/**`,
        ` * Record a single ${entityName} LLM call: extract the response VO and persist a`,
        ` * trace row via ObjectManager regardless of whether extraction succeeded.`,
        ` *`,
        ` * @param om         - ObjectManager wired to the application database.`,
        ` * @param responseMo - MetaObject for \`${responseRef}\` (resolve via the loaded`,
        ` *                     metadata root: \`root.findObject("${responseRef}")\`).`,
        ` *                     Passed explicitly because ObjectManager does not expose`,
        ` *                     its loaded metadata root.`,
        ` * @param input      - LLM call inputs; type \`llmRequest\` as \`${requestType}\`.`,
        ` */`,
        `export async function ${fnName}(`,
        `  om: ObjectManager,`,
        `  responseMo: MetaObject,`,
        `  input: Omit<LlmCallInput, "llmRequest"> & { llmRequest: ${requestType} },`,
        `): Promise<${entityName}TraceResult> {`,
        `  const result = await recordLlmCall(input, {`,
        `    recorder: new LlmCallDbRecorder(om, "${entityName}"),`,
        `    responseMo,`,
        `    format: Format.JSON,`,
        `  });`,
        `  return result as ${entityName}TraceResult;`,
        `}`,
        ``,
      ];

      return [{
        path: `${dirPrefix}${entityName}.trace.ts`,
        content: lines.join("\n"),
      }];
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<TraceHelperOpts>;

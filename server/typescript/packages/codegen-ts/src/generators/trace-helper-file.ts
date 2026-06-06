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
  TEMPLATE_ATTR_FORMAT,
  TEMPLATE_ATTR_TEXT_REF,
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
import { LLM_CALL_BASE } from "../ai/derive-trace-fields.js";
import { tphDiscriminatorPin } from "../templates/zod-validators.js";

export interface TraceHelperOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

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

      // STI: a trace entity that is a TPH subtype stamps its declared
      // discriminator value as callType and drops callType from the caller input
      // (industry-standard STI — the discriminator is framework-managed).
      const tphPin = tphDiscriminatorPin(entity);
      const sti = tphPin !== undefined;
      const callTypeValue = sti ? tphPin.value : entityName;

      // Emitted record<Entity> fragments: the keys Omit'd from the caller input,
      // and the first argument passed to recordLlmCall.
      const recordInputOmit = sti ? `"llmRequest" | "callType"` : `"llmRequest"`;
      const recordArg = sti ? `{ ...input, callType: ${JSON.stringify(callTypeValue)} }` : `input`;

      // Derive the parse format from the prompt's @format attr.
      // "xml" → Format.XML; absent or any other value → Format.JSON.
      const promptFormat = prompt.ownAttr(TEMPLATE_ATTR_FORMAT);
      const formatLiteral = typeof promptFormat === "string" && promptFormat.toLowerCase() === "xml"
        ? "Format.XML"
        : "Format.JSON";

      // Collect VO names for interface emission (dedupe via batch emitter).
      const voNames: string[] = [];
      if (typeof payloadRef === "string") voNames.push(payloadRef);
      voNames.push(responseRef);

      // Emit the shared payload interfaces inline (same approach as prompt-render-file).
      const interfaces = generatePayloadInterfacesBatch(ctx.loadedRoot, voNames);

      const requestType = typeof payloadRef === "string" ? payloadRef : "unknown";

      // A renderable prompt (carries @textRef) gets an additional call<Entity> helper
      // that renders the prompt text, calls the LLM, then parses + persists a trace row.
      const textRef = prompt.ownAttr(TEMPLATE_ATTR_TEXT_REF);
      const renderable = typeof textRef === "string";
      const renderFormat = typeof promptFormat === "string" ? promptFormat : "text";

      // Build the import block — all imports MUST stay at the top of the emitted file.
      const importLines: string[] = [
        `import type { ObjectManager } from "@metaobjectsdev/runtime-ts";`,
        `import {`,
        `  LlmCallDbRecorder,`,
        `  recordLlmCall,`,
        `  type LlmCallInput,`,
        `  type RecordLlmCallResult,`,
        `} from "@metaobjectsdev/runtime-ts";`,
        `import { Format } from "@metaobjectsdev/runtime-ts";`,
        `import type { MetaObject } from "@metaobjectsdev/metadata";`,
      ];
      if (renderable) {
        importLines.push(
          `import { render, type Provider } from "@metaobjectsdev/render";`,
          `import {`,
          `  callLlm,`,
          `  type LlmClient,`,
          `  type LlmRequest,`,
          `  type CallLlmInput,`,
          `  type CallLlmDeps,`,
          `  type CostFn,`,
          `  type Clock,`,
          `  type IdGen,`,
          `} from "@metaobjectsdev/ai-runtime";`,
        );
      }

      const lines: string[] = [
        `// ${GENERATED_HEADER} — DO NOT EDIT.`,
        ``,
        ...importLines,
        ``,
        `// ---- Payload interfaces (inlined) ------------------------------------------`,
        ``,
        interfaces.trimEnd(),
        ``,
        `// ---- Typed result -----------------------------------------------------------`,
        ``,
        `export interface ${entityName}TraceResult extends RecordLlmCallResult {`,
        `  /** Parsed response VO, or null when extraction reported a lost-required field. */`,
        `  /** Note: voResponse is the plain extracted record typed as the response shape (structural, not an instance). */`,
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
        `  input: Omit<LlmCallInput, ${recordInputOmit}> & { llmRequest: ${requestType} },`,
        `): Promise<${entityName}TraceResult> {`,
        `  const result = await recordLlmCall(${recordArg}, {`,
        `    recorder: new LlmCallDbRecorder(om, "${entityName}"),`,
        `    responseMo,`,
        `    format: ${formatLiteral},`,
        `  });`,
        `  return result as ${entityName}TraceResult;`,
        `}`,
        ``,
      ];

      if (renderable) {
        const callFn = `call${pascal(entityName)}`;
        lines.push(
          ``,
          `// ---- Call helper (GENERATE -> CALL -> record) -------------------------------`,
          ``,
          `export interface ${entityName}CallDeps {`,
          `  om: ObjectManager;`,
          `  responseMo: MetaObject;`,
          `  client: LlmClient;`,
          `  /** Prompt-TEXT resolver for render() (NOT the LLM client). */`,
          `  provider: Provider;`,
          `  model: string;`,
          `  system?: string;`,
          `  params?: Record<string, unknown>;`,
          `  cost?: CostFn;`,
          `  clock?: Clock;`,
          `  ids?: IdGen;`,
          `  traceId?: string;`,
          `  parentSpanId?: string;`,
          `  sessionId?: string;`,
          `}`,
          ``,
          `/**`,
          ` * Render the ${entityName} prompt, call the LLM, then parse + persist a trace`,
          ` * row (finally-style: a call/parse failure still writes a row).`,
          ` */`,
          `export async function ${callFn}(`,
          `  payload: ${requestType},`,
          `  deps: ${entityName}CallDeps,`,
          `): Promise<${entityName}TraceResult> {`,
          `  const prompt = render({ ref: ${JSON.stringify(textRef)}, payload, format: ${JSON.stringify(renderFormat)}, provider: deps.provider });`,
          // Build request/input/deps conditionally so that an absent optional (T |
          // undefined) is never assigned to an optional T? property — required for
          // exactOptionalPropertyTypes-strict consumer projects.
          `  const request: LlmRequest = { prompt, model: deps.model };`,
          `  if (deps.system !== undefined) request.system = deps.system;`,
          `  if (deps.params !== undefined) request.params = deps.params;`,
          `  const callInput: CallLlmInput = { callType: ${JSON.stringify(callTypeValue)}, payload, request };`,
          `  if (deps.traceId !== undefined) callInput.traceId = deps.traceId;`,
          `  if (deps.parentSpanId !== undefined) callInput.parentSpanId = deps.parentSpanId;`,
          `  if (deps.sessionId !== undefined) callInput.sessionId = deps.sessionId;`,
          `  const callDeps: CallLlmDeps = {`,
          `    client: deps.client,`,
          `    recorder: new LlmCallDbRecorder(deps.om, ${JSON.stringify(entityName)}),`,
          `    responseMo: deps.responseMo,`,
          `    format: ${formatLiteral},`,
          `  };`,
          `  if (deps.cost !== undefined) callDeps.cost = deps.cost;`,
          `  if (deps.clock !== undefined) callDeps.clock = deps.clock;`,
          `  if (deps.ids !== undefined) callDeps.ids = deps.ids;`,
          `  const result = await callLlm(callInput, callDeps);`,
          `  return result as ${entityName}TraceResult;`,
          `}`,
        );
      }

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

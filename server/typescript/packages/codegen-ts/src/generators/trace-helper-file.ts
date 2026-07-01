// server/typescript/packages/codegen-ts/src/generators/trace-helper-file.ts
//
// Stock generator that emits one <Entity>.trace.ts helper file for each concrete
// entity that (a) extends LlmCallBase (directly or transitively) and (b) nests a
// template.prompt with @payloadRef and/or @responseRef.
//
// The emitted helper exports an async function `record<Entity>(om, responseMo, input)`
// that EXTRACTS the typed response VO itself and persists ONE row = base envelope +
// raw I/O (via buildLlmCallRow) PLUS the typed voRequest/voResponse columns. The
// helper is typed against the generated payload interfaces (request + response VOs)
// so call-sites get compile-time checks.
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
import { tphDiscriminatorPin } from "../templates/zod-validators.js";

/** Short name of the shipped abstract base every trace entity extends. */
const LLM_CALL_BASE = "LlmCallBase";

export interface TraceHelperOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

/** Walk the super chain looking for a node named LLM_CALL_BASE. */
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
      // ADR-0039: resolving — a concrete trace entity may inherit its
      // template.prompt from an abstract base (it extendsBase); own-only would
      // miss the inherited prompt.
      const prompt = entity.children().find(
        (c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_PROMPT,
      );
      if (prompt === undefined) return [];

      // ADR-0039: resolving — a prompt may inherit @payloadRef/@responseRef via extends.
      const payloadRef = prompt.attr(TEMPLATE_ATTR_PAYLOAD_REF);
      const responseRef = prompt.attr(TEMPLATE_ATTR_RESPONSE_REF);

      // @responseRef types the result; @payloadRef types the request. Both gate
      // the helper: the entity must declare voRequest/voResponse field.object
      // columns (authored) for these writes to land, and the prompt's refs name
      // the VOs to render/extract into.
      if (typeof responseRef !== "string") return [];
      if (typeof payloadRef !== "string") return [];

      const entityName = entity.name;
      const fnName = `record${pascal(entityName)}`;

      // STI: a trace entity that is a TPH subtype stamps its declared
      // discriminator value as callType and drops callType from the caller input
      // (industry-standard STI — the discriminator is framework-managed).
      const tphPin = tphDiscriminatorPin(entity);
      const sti = tphPin !== undefined;
      const callTypeValue = sti ? tphPin.value : entityName;

      // Emitted record<Entity> fragments. The caller never supplies the derived
      // status/errorDetail (the helper computes them from extraction), and an STI
      // subtype additionally drops the framework-managed callType discriminator.
      const recordInputOmit = sti
        ? `"llmRequest" | "status" | "errorDetail" | "callType"`
        : `"llmRequest" | "status" | "errorDetail"`;
      // The object spread passed to buildLlmCallRow: STI subtypes stamp their
      // discriminator value, all helpers fold in the derived status/errorDetail.
      const recordBuildArg = sti
        ? `{ ...input, callType: ${JSON.stringify(callTypeValue)}, status, errorDetail }`
        : `{ ...input, status, errorDetail }`;

      // Derive the parse format from the prompt's @format attr.
      // "xml" → Format.XML; absent or any other value → Format.JSON.
      // ADR-0039: resolving — a prompt may inherit @format via extends.
      const promptFormat = prompt.attr(TEMPLATE_ATTR_FORMAT);
      const formatLiteral = typeof promptFormat === "string" && promptFormat.toLowerCase() === "xml"
        ? "Format.XML"
        : "Format.JSON";

      // Collect VO names for interface emission (dedupe via batch emitter).
      // Both refs are guaranteed strings by the guards above.
      const interfaces = generatePayloadInterfacesBatch(ctx.loadedRoot, [payloadRef, responseRef]);

      const requestType = payloadRef;

      // A renderable prompt (carries @textRef) gets an additional call<Entity> helper
      // that renders the prompt text, calls the LLM, then parses + persists a trace row.
      // ADR-0039: resolving — a prompt may inherit @textRef via extends.
      const textRef = prompt.attr(TEMPLATE_ATTR_TEXT_REF);
      const renderable = typeof textRef === "string";
      // Same @format attr, two intentionally different shapes: extract() takes the
      // Format enum (formatLiteral, above → Format.XML/Format.JSON), render() takes the
      // raw format string (renderFormat, here → e.g. "json"/"xml", default "text").
      const renderFormat = typeof promptFormat === "string" ? promptFormat : "text";

      // Build the import block — all imports MUST stay at the top of the emitted file.
      // `extract` + `render` both live in @metaobjectsdev/render: import them together
      // (one de-duplicated statement) when the prompt is renderable, else import only
      // `extract`.
      const importLines: string[] = [
        `import type { ObjectManager } from "@metaobjectsdev/runtime-ts";`,
        `import {`,
        `  LlmCallDbRecorder,`,
        `  buildLlmCallRow,`,
        `  persistLlmCallRow,`,
        `  extractSchemaFor,`,
        `  Format,`,
        `  type LlmCallInput,`,
        `  type LlmCallRow,`,
        `} from "@metaobjectsdev/runtime-ts";`,
        renderable
          ? `import { extract, render, type Provider } from "@metaobjectsdev/render";`
          : `import { extract } from "@metaobjectsdev/render";`,
        `import type { MetaObject } from "@metaobjectsdev/metadata";`,
      ];
      if (renderable) {
        importLines.push(
          `import {`,
          `  runLlmCall,`,
          `  type RunLlmCallInput,`,
          `  type RunLlmCallDeps,`,
          `  type LlmClient,`,
          `  type LlmRequest,`,
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
        `export interface ${entityName}TraceResult {`,
        `  status: "ok" | "error";`,
        `  errorDetail: string | null;`,
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
        ` * @param opts       - Optional \`redact\` hook applied to the row before persist`,
        ` *                     (scrub PII/secrets on the typed path, same as the generic`,
        ` *                     recordLlmCall/callLlm helpers).`,
        ` */`,
        `export async function ${fnName}(`,
        `  om: ObjectManager,`,
        `  responseMo: MetaObject,`,
        `  input: Omit<LlmCallInput, ${recordInputOmit}> & { llmRequest: ${requestType} },`,
        `  opts?: { redact?: (row: LlmCallRow) => LlmCallRow },`,
        `): Promise<${entityName}TraceResult> {`,
        `  const schema = extractSchemaFor(responseMo, ${formatLiteral});`,
        `  const outcome = extract(input.llmResponseText, schema);`,
        `  const failed = outcome.report.hasLostRequired();`,
        `  const status = failed ? ("error" as const) : ("ok" as const);`,
        '  const errorDetail = failed ? `lost required: ${outcome.report.lostRequired().join(", ")}` : null;',
        `  const base = buildLlmCallRow(${recordBuildArg});`,
        `  const row = { ...base, voRequest: input.llmRequest, voResponse: failed ? null : outcome.data };`,
        `  await persistLlmCallRow(new LlmCallDbRecorder(om, "${entityName}"), row, opts?.redact ? { redact: opts.redact } : undefined);`,
        `  return { status, errorDetail, voResponse: failed ? null : (outcome.data as ${responseRef}) };`,
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
          `  /** Optional row-redaction hook applied before persist (scrub PII/secrets). */`,
          `  redact?: (row: LlmCallRow) => LlmCallRow;`,
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
          `  const runInput: RunLlmCallInput = { callType: ${JSON.stringify(callTypeValue)}, request };`,
          `  if (deps.traceId !== undefined) runInput.traceId = deps.traceId;`,
          `  if (deps.parentSpanId !== undefined) runInput.parentSpanId = deps.parentSpanId;`,
          `  if (deps.sessionId !== undefined) runInput.sessionId = deps.sessionId;`,
          `  const runDeps: RunLlmCallDeps = { client: deps.client };`,
          `  if (deps.cost !== undefined) runDeps.cost = deps.cost;`,
          `  if (deps.clock !== undefined) runDeps.clock = deps.clock;`,
          `  if (deps.ids !== undefined) runDeps.ids = deps.ids;`,
          `  const { input: recInput, completion } = await runLlmCall(runInput, runDeps);`,
          `  let voResponse: ${responseRef} | null = null;`,
          `  let status = recInput.status;`,
          `  let errorDetail = recInput.errorDetail;`,
          `  if (completion !== undefined) {`,
          `    const outcome = extract(completion.body, extractSchemaFor(deps.responseMo, ${formatLiteral}));`,
          `    if (outcome.report.hasLostRequired()) {`,
          `      status = "error";`,
          '      errorDetail = `lost required: ${outcome.report.lostRequired().join(", ")}`;',
          `    } else {`,
          `      voResponse = outcome.data as ${responseRef};`,
          `    }`,
          `  }`,
          `  const row = { ...buildLlmCallRow({ ...recInput, status, errorDetail }), voRequest: payload, voResponse };`,
          `  await persistLlmCallRow(new LlmCallDbRecorder(deps.om, ${JSON.stringify(entityName)}), row, deps.redact ? { redact: deps.redact } : undefined);`,
          `  return { status, errorDetail, voResponse };`,
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

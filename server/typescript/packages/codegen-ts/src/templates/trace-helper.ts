// The `<Entity>.trace.ts` composer behind the `trace-helper` generator.
//
// One module per concrete entity that (a) extends a library's declared trace anchor
// (directly or transitively) and (b) nests a template.prompt carrying @payloadRef and
// @responseRef. It exports `record<Entity>(om, responseMo, input)`, which EXTRACTS the
// typed response VO itself and persists ONE row = base envelope + raw I/O (via
// buildLlmCallRow) PLUS the typed voRequest/voResponse columns, and for a renderable
// prompt (one carrying @textRef) a `call<Entity>` that renders, calls and records.
//
// The helper is typed against the request and response value objects' OWN interfaces
// (ADR-0056 — imported from the modules entityFile() declares them in, never inlined),
// so call-sites get compile-time checks.
//
// NOTE: ObjectManager does not expose its loaded metadata root, so the caller must
// pass the resolved `responseMo: MetaObject` explicitly. The generated helper
// documents this in its JSDoc.
//
// Lives here, apart from the generator, so the built-in factory and the reference
// template `meta eject trace-helper` copies call ONE composer: an adopter owns which
// entities get a helper and where it lands, and the module body stays here.

import {
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_RESPONSE_REF,
  TEMPLATE_ATTR_FORMAT,
  RESPONSE_FORMAT_XML,
  TEMPLATE_ATTR_TEXT_REF,
  refTarget,
} from "@metaobjectsdev/metadata";
import type { MetaData, MetaObject } from "@metaobjectsdev/metadata";
import { libraryManifests } from "@metaobjectsdev/metadata/library";
import type { GenContext } from "../generator.js";
import { responseFormatOf } from "./find-inbound.js";
import { valueObjectImport, valueObjectImportLines } from "./value-object-import.js";
import { GENERATED_HEADER, GENERATED_EDIT_NOTE } from "../constants.js";
import { toPascalCase } from "../naming.js";
import { tphDiscriminatorPin } from "../tph.js";

/** The generator's stable name — the key a library manifest declares its anchor under. */
export const TRACE_HELPER_STABLE_NAME = "trace-helper";

/**
 * The FQNs the trace-helper generator keys on, from the LIBRARY MANIFESTS rather than a
 * constant here (FR-043 §6).
 *
 * What it replaces: `const LLM_CALL_BASE = "LlmCallBase"`, compared against `.name`
 * anywhere in the super chain — so any adopter entity called `LlmCallBase`, in any
 * package, triggered the generator. An anchor is a fully-qualified node the library
 * declares, and it is resolved to a node and compared by identity below.
 *
 * `ctx.libraries` undefined means the caller never said which libraries are selected
 * (a programmatic `runGen()`); every shipped manifest's anchor is then a candidate,
 * which is still FQN-anchored. An EMPTY array is the opposite and is honoured: the
 * caller looked, this project opted into none, and the generator matches nothing.
 */
function anchorFqns(ctx: GenContext): string[] {
  const manifests = ctx.libraries ?? Object.values(libraryManifests());
  const out: string[] = [];
  for (const manifest of manifests) {
    for (const g of manifest.generators ?? []) {
      if (g.name === TRACE_HELPER_STABLE_NAME && g.anchor !== undefined) out.push(g.anchor);
    }
  }
  return out;
}

/**
 * The trace anchors of this run, as NODES: each anchor FQN resolved against the loaded
 * root, skipping any the model does not hold. A property of the run, not of an entity —
 * resolve it once and pass it to {@link extendsTraceAnchor}.
 */
export function traceAnchorNodes(ctx: GenContext): MetaData[] {
  const wanted = new Set(anchorFqns(ctx));
  if (wanted.size === 0) return [];
  return ctx.loadedRoot.children().filter((n) => wanted.has(n.resolutionKey()));
}

/**
 * Walk the super chain looking for one of the anchor NODES.
 *
 * Node identity, not `.name` and not even the FQN string: the anchors were resolved
 * against this run's own loaded root, so an entity whose chain reaches one reaches
 * exactly the node the library declared.
 */
export function extendsTraceAnchor(obj: MetaObject, anchors: readonly MetaData[]): boolean {
  if (anchors.length === 0) return false;
  for (let cur = obj.superResolved; cur !== undefined; cur = cur.superResolved) {
    if (anchors.includes(cur)) return true;
  }
  return false;
}

/**
 * Render the `<Entity>.trace.ts` module for one trace entity, or `undefined` when the
 * entity carries nothing to type a helper by: no nested template.prompt, a prompt
 * missing @payloadRef or @responseRef, or a ref that resolves to no value object.
 *
 * `outPath` is the path the module will be written to, relative to its target's outDir;
 * the value-object imports are spelled relative to it. Whether the entity is a trace
 * entity at all (concrete, extends an anchor) is the CALLER's question — see
 * {@link traceAnchorNodes} / {@link extendsTraceAnchor}.
 */
export function renderTraceHelper(entity: MetaObject, ctx: GenContext, outPath: string): string | undefined {
  // Find the nested template.prompt.
  // ADR-0039: resolving — a concrete trace entity may inherit its
  // template.prompt from an abstract base (it extendsBase); own-only would
  // miss the inherited prompt.
  const prompt = entity.children().find(
    (c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_PROMPT,
  );
  if (prompt === undefined) return undefined;

  // ADR-0039: resolving — a prompt may inherit @payloadRef/@responseRef via extends.
  const payloadRef = prompt.attr(TEMPLATE_ATTR_PAYLOAD_REF);
  const responseRef = prompt.attr(TEMPLATE_ATTR_RESPONSE_REF);

  // @responseRef types the result; @payloadRef types the request. Both gate
  // the helper: the entity must declare voRequest/voResponse field.object
  // columns (authored) for these writes to land, and the prompt's refs name
  // the VOs to render/extract into.
  if (typeof responseRef !== "string") return undefined;
  if (typeof payloadRef !== "string") return undefined;

  const entityName = entity.name;
  const fnName = `record${toPascalCase(entityName)}`;

  // ADR-0056: the request and response types are the value objects' OWN interfaces. ADR-0059
  // R7: each is the value object the loader bound for the prompt's ref.
  const requestVo = refTarget(prompt, TEMPLATE_ATTR_PAYLOAD_REF);
  const responseVo = refTarget(prompt, TEMPLATE_ATTR_RESPONSE_REF);
  if (requestVo === undefined || responseVo === undefined) return undefined;
  const extStyle = ctx.config.extStyle ?? "js";
  const requestImport = valueObjectImport(ctx.renderContext, requestVo, outPath, extStyle);
  const responseImport = valueObjectImport(ctx.renderContext, responseVo, outPath, extStyle);
  const requestType = requestImport.name;
  const responseType = responseImport.name;

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

  // ADR-0053: the REPLY's syntax is @responseFormat, not @format.
  //
  // This site used to read @format twice — once as the reply's syntax and once
  // as the prompt body's — under a comment calling them "two intentionally
  // different shapes". They are two different FACTS, not two shapes of one:
  // a plain-text prompt can elicit an XML reply, and the shipped docs-site
  // fixture is exactly that. Reading @format here mis-parsed every prompt whose
  // body format differed from its reply's.
  //
  // The same rule the output-parser / extractor / response-format-fragment
  // generators use — all four now go through responseFormatOf().
  const formatLiteral =
    responseFormatOf(prompt) === RESPONSE_FORMAT_XML ? "Format.XML" : "Format.JSON";

  // A renderable prompt (carries @textRef) gets an additional call<Entity> helper
  // that renders the prompt text, calls the LLM, then parses + persists a trace row.
  // ADR-0039: resolving — a prompt may inherit @textRef via extends.
  const textRef = prompt.attr(TEMPLATE_ATTR_TEXT_REF);
  const renderable = typeof textRef === "string";
  // render() takes the raw format string of the prompt BODY — @format, which is
  // genuinely this attribute's job. Distinct from formatLiteral above, which is
  // the REPLY's syntax and comes from @responseFormat (ADR-0053).
  // ADR-0039: resolving — a prompt may inherit @format via extends.
  const promptFormat = prompt.attr(TEMPLATE_ATTR_FORMAT);
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
      ? `import { extract, render, type ExtractionReport, type Provider } from "@metaobjectsdev/render";`
      : `import { extract, type ExtractionReport } from "@metaobjectsdev/render";`,
    `import type { MetaObject } from "@metaobjectsdev/metadata";`,
    ...valueObjectImportLines([requestImport, responseImport]),
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
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
    ``,
    ...importLines,
    ``,
    `// ---- Typed result -----------------------------------------------------------`,
    ``,
    `export interface ${entityName}TraceResult {`,
    `  status: "ok" | "error";`,
    `  errorDetail: string | null;`,
    `  /** Parsed response VO, or null when a required field was lost or malformed. */`,
    `  /** Note: voResponse is the plain extracted record typed as the response shape (structural, not an instance). */`,
    `  voResponse: ${responseType} | null;`,
    `}`,
    ``,
    `/**`,
    ` * The failure detail when a required response field is unusable — lost (absent) or`,
    ` * malformed (present but not coercible) — else null. Either way its value is missing,`,
    ` * so the response must not be handed back typed as \`${responseType}\`.`,
    ` */`,
    `function unusableRequired(report: ExtractionReport): string | null {`,
    `  const parts: string[] = [];`,
    '  if (report.hasLostRequired()) parts.push(`lost required: ${report.lostRequired().join(", ")}`);',
    '  if (report.hasMalformedRequired()) parts.push(`malformed required: ${report.malformedRequired().join(", ")}`);',
    `  return parts.length > 0 ? parts.join("; ") : null;`,
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
    `  const errorDetail = unusableRequired(outcome.report);`,
    `  const failed = errorDetail !== null;`,
    `  const status = failed ? ("error" as const) : ("ok" as const);`,
    `  const base = buildLlmCallRow(${recordBuildArg});`,
    `  const row = { ...base, voRequest: input.llmRequest, voResponse: failed ? null : outcome.data };`,
    `  await persistLlmCallRow(new LlmCallDbRecorder(om, "${entityName}"), row, opts?.redact ? { redact: opts.redact } : undefined);`,
    `  return { status, errorDetail, voResponse: failed ? null : (outcome.data as ${responseType}) };`,
    `}`,
    ``,
  ];

  if (renderable) {
    const callFn = `call${toPascalCase(entityName)}`;
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
      `  let voResponse: ${responseType} | null = null;`,
      `  let status = recInput.status;`,
      `  let errorDetail = recInput.errorDetail;`,
      `  if (completion !== undefined) {`,
      `    const outcome = extract(completion.body, extractSchemaFor(deps.responseMo, ${formatLiteral}));`,
      `    const unusable = unusableRequired(outcome.report);`,
      `    if (unusable !== null) {`,
      `      status = "error";`,
      `      errorDetail = unusable;`,
      `    } else {`,
      `      voResponse = outcome.data as ${responseType};`,
      `    }`,
      `  }`,
      `  const row = { ...buildLlmCallRow({ ...recInput, status, errorDetail }), voRequest: payload, voResponse };`,
      `  await persistLlmCallRow(new LlmCallDbRecorder(deps.om, ${JSON.stringify(entityName)}), row, deps.redact ? { redact: deps.redact } : undefined);`,
      `  return { status, errorDetail, voResponse };`,
      `}`,
    );
  }

  return lines.join("\n");
}

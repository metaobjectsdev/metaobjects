// server/typescript/packages/codegen-ts/src/templates/find-inbound.ts
//
// The ADR-0052 direction rule, in ONE place.
//
// A template subtype's axis is DIRECTION: `template.output` renders outbound (a
// document or an email) and generates no parser; the inbound half — the response
// shape, the FR-010 response-format fragment, and the parser-on-receipt — belongs
// to a `template.prompt` that declares `@responseRef`.
//
// Every inbound generator calls through here rather than re-deriving "which
// templates have a response". Three call sites each deciding for themselves is
// exactly how the pre-ADR-0052 tier drifted: the parser had no `@kind` filter at
// all, so an email template generated a parser for text the system had just
// rendered, while the extractor and the fragment emitter each applied a different
// json/xml gate.

import {
  type MetaData,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_ATTR_RESPONSE_REF,
  TEMPLATE_ATTR_RESPONSE_FORMAT,
  RESPONSE_FORMAT_DEFAULT,
  RESPONSE_FORMAT_XML,
  type ResponseFormat,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";

/** What an inbound generator needs about one responding prompt. */
export interface InboundShape {
  /** The resolved response value-object — the shape a reply is parsed INTO. */
  readonly vo: MetaData;
  /** The `@responseRef` string as authored (bare or fully-qualified). */
  readonly ref: string;
  /**
   * The syntax of the REPLY (ADR-0053) — never the template's `@format`, which is
   * the syntax of the rendered prompt BODY. The two genuinely differ.
   */
  readonly format: ResponseFormat;
}

/**
 * Every `template.prompt` that declares a response shape, in declaration order.
 *
 * The gate is `@responseRef` PRESENCE, not a format value: declaring a response
 * shape is the request for a parser. Gating on `@format` was what let a `text`
 * template get a strict parser but no tolerant extract, and — because `@format`
 * defaults to `text` — would silently emit nothing at all after the re-homing.
 *
 * ADR-0039: resolving accessors throughout. A root has no super, but a template
 * may inherit `@responseRef` from an abstract base via `extends`, and three
 * shipped fixtures rely on exactly that.
 */
export function inboundTemplates(root: MetaData): MetaData[] {
  return root
    .children()
    .filter(
      (c) =>
        c.type === TYPE_TEMPLATE &&
        c.subType === TEMPLATE_SUBTYPE_PROMPT &&
        typeof c.attr(TEMPLATE_ATTR_RESPONSE_REF) === "string",
    );
}

/**
 * Resolve a prompt's response value-object and reply syntax.
 *
 * Returns `undefined` when the template declares no `@responseRef` or the ref does
 * not resolve — callers skip rather than throw, matching the pre-ADR-0052 contract
 * for an unresolvable payload ref.
 */
export function responseShape(root: MetaData, tmpl: MetaData): InboundShape | undefined {
  // ADR-0039: resolving — @responseRef may be inherited via extends.
  const ref = tmpl.attr(TEMPLATE_ATTR_RESPONSE_REF);
  if (typeof ref !== "string") return undefined;
  // ADR-0042: a bare @responseRef resolves package-locally, then root-level.
  const vo = resolveObjectRef(root, ref, tmpl.package ?? tmpl.fileDefaultPackage ?? "").node;
  if (!vo) return undefined;
  return { vo, ref, format: responseFormatOf(tmpl) };
}

/**
 * The declared reply syntax, defaulted per ADR-0053.
 *
 * The default is `json` because that reproduces the trace helper's pre-ADR-0053
 * fallback exactly (anything that was not `"xml"` was treated as JSON), which is
 * what makes the attribute's introduction behaviour-preserving rather than a new
 * policy.
 */
export function responseFormatOf(tmpl: MetaData): ResponseFormat {
  // ADR-0039: resolving — @responseFormat may be inherited via extends.
  const raw = tmpl.attr(TEMPLATE_ATTR_RESPONSE_FORMAT);
  return typeof raw === "string" && raw.toLowerCase() === RESPONSE_FORMAT_XML
    ? RESPONSE_FORMAT_XML
    : RESPONSE_FORMAT_DEFAULT;
}

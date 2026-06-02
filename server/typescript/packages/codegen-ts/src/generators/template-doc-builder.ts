// Walk one `template.output` node (+ root) into the NEUTRAL TemplateDocData
// shape the `docs/template-page.md` Mustache template consumes. The attr reads
// MIRROR render-helper-file.ts / templates/render-helper.ts (@kind, @payloadRef,
// @textRef, @format, @maxChars, @requiredTags; for email @subjectRef /
// @htmlBodyRef / @textBodyRef) — but this builder emits DESCRIPTION, never code:
// no helper signatures, no language types. `capability` is a FIXED, neutral
// sentence per @kind.

import {
  type MetaData,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_FORMAT,
  TEMPLATE_ATTR_MAX_CHARS,
  TEMPLATE_ATTR_KIND,
  TEMPLATE_KIND_EMAIL,
  TEMPLATE_KIND_DOCUMENT,
  TEMPLATE_KIND_DEFAULT,
  TEMPLATE_ATTR_SUBJECT_REF,
  TEMPLATE_ATTR_HTML_BODY_REF,
  TEMPLATE_ATTR_TEXT_BODY_REF,
  TEMPLATE_ATTR_REQUIRED_TAGS,
  DOC_ATTR_DESCRIPTION,
  stripPackage,
} from "@metaobjectsdev/metadata";
import { GENERATED_HEADER } from "../constants.js";
import type { TemplateDocData, TemplateOutputPart } from "./template-doc-data.js";

// FIXED, language-NEUTRAL capability sentences. NO type names, NO signatures.
const CAPABILITY_DOCUMENT =
  "A render helper is generated for this template: it takes the payload and " +
  "returns the rendered output as a single string.";
const CAPABILITY_EMAIL =
  "A render helper is generated for this template: it takes the payload and " +
  "returns the rendered email — subject, HTML body, and an optional text body.";

/** Read an attr that may be a string or string[] (string-array attrs come back
 *  as string[]; a bare comma string is split defensively). Returns a trimmed,
 *  non-empty string list. */
function attrStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

function readMaxChars(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function templateDescription(t: MetaData): string | undefined {
  const v = t.attr(DOC_ATTR_DESCRIPTION);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Build the TemplateDocData for one `template.output` node. */
export function buildTemplateDocData(template: MetaData): TemplateDocData {
  const kindRaw = ((template.ownAttr(TEMPLATE_ATTR_KIND) as string | undefined) ??
    TEMPLATE_KIND_DEFAULT).toLowerCase();
  const isEmail = kindRaw === TEMPLATE_KIND_EMAIL;
  const kind: "document" | "email" = isEmail ? TEMPLATE_KIND_EMAIL : TEMPLATE_KIND_DOCUMENT;

  const payloadRefRaw = template.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
  const payloadName =
    typeof payloadRefRaw === "string" && payloadRefRaw.length > 0
      ? stripPackage(payloadRefRaw)
      : "unknown";

  const requiredTags = attrStringList(template.ownAttr(TEMPLATE_ATTR_REQUIRED_TAGS));
  const maxChars = readMaxChars(template.ownAttr(TEMPLATE_ATTR_MAX_CHARS));

  let format = "";
  let parts: TemplateOutputPart[] | undefined;
  const sourceRefs: string[] = [];

  if (isEmail) {
    const subjectRef = template.ownAttr(TEMPLATE_ATTR_SUBJECT_REF);
    const htmlBodyRef = template.ownAttr(TEMPLATE_ATTR_HTML_BODY_REF);
    const textBodyRef = template.ownAttr(TEMPLATE_ATTR_TEXT_BODY_REF);
    parts = [];
    if (typeof subjectRef === "string") {
      parts.push({ label: "Subject", ref: subjectRef, format: "text", escaped: false });
      sourceRefs.push(subjectRef);
    }
    if (typeof htmlBodyRef === "string") {
      parts.push({ label: "HTML body", ref: htmlBodyRef, format: "html", escaped: true });
      sourceRefs.push(htmlBodyRef);
    }
    if (typeof textBodyRef === "string") {
      parts.push({ label: "Text body", ref: textBodyRef, format: "text", escaped: false });
      sourceRefs.push(textBodyRef);
    }
  } else {
    format = ((template.ownAttr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text").toLowerCase();
    const textRef = template.ownAttr(TEMPLATE_ATTR_TEXT_REF);
    if (typeof textRef === "string") sourceRefs.push(textRef);
  }

  const data: TemplateDocData = {
    generatedMarker: `<!-- ${GENERATED_HEADER} — DO NOT EDIT. -->`,
    name: template.name,
    kind,
    isEmail,
    format,
    payload: { name: payloadName, link: `./${payloadName}.md` },
    referencedFields: requiredTags,
    sourceRefs,
    capability: isEmail ? CAPABILITY_EMAIL : CAPABILITY_DOCUMENT,
  };

  if (parts !== undefined) data.parts = parts;
  if (requiredTags.length > 0) {
    data.requiredTags = requiredTags;
    data.hasRequiredTags = true;
  }
  if (maxChars !== undefined) data.maxChars = maxChars;

  const desc = templateDescription(template);
  if (desc !== undefined) {
    data.descriptionQuote = desc.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
  }

  return data;
}
